import { normalizeTags, type KawaScenarioCard, type PublishResult, type ScenarioLookup, type UserRef } from "@shared/api";
import { account, api } from "@root/api";
import { refToBlob } from "@root/media";
import { idb, isRemoteRef, listen, local } from "@root/persist";
import type { Result, ScenarioCard } from "@root/types";
import { makeTagIndex, makeTagLookup, type TagIndex, type TagLabels, type TagLookup, type TagSources } from "@shared/tags";

/*
Glue between the local library and the server catalog:
downloading cards, publishing and delisting them, the tag vocabulary and the hidden-content tag list.
*/

export function userLink(username: string) {
	return `/u/${encodeURIComponent(username)}`;
}
export function scenarioLink(id: string) {
	return `/c/${encodeURIComponent(id)}`;
}

/** fetches a published card and stores it in the local library, server timestamps included */
export async function saveToLibrary(id: string): Promise<Result<KawaScenarioCard, string>> {
	const r = await api<KawaScenarioCard>("GET", `/api/scenarios/${encodeURIComponent(id)}`);
	if (!r.success) return r;
	forgetLookup(id);
	await idb.set("scenarios", r.value);
	return r;
}

/*
Published state of local cards is cached, so re-renders of the library and editor don't ask the server again
and don't shift the layout once a card's status is known. `null` = not published.
*/
const LOOKUP_TTL = 5 * 60_000;
const lookupCache = new Map<string, { value: ScenarioLookup | null, at: number }>();

export function peekLookup(id: string): ScenarioLookup | null | undefined {
	const entry = lookupCache.get(id);
	if (!entry || Date.now() - entry.at > LOOKUP_TTL) return undefined;
	return entry.value;
}
export function forgetLookup(id: string) {
	lookupCache.delete(id);
}

export async function lookupScenarios(ids: string[]): Promise<Map<string, ScenarioLookup>> {
	const result = new Map<string, ScenarioLookup>();
	const missing: string[] = [];
	for (const id of ids) {
		const known = peekLookup(id);
		if (known === undefined) missing.push(id);
		else if (known) result.set(id, known);
	}
	if (missing.length === 0) return result;

	const r = await api<{ items: ScenarioLookup[] }>("POST", "/api/scenarios/lookup", { ids: missing });
	if (!r.success) return result;
	const at = Date.now();
	const found = new Map(r.value.items.map(i => [i.id, i]));
	for (const id of missing) {
		const value = found.get(id) ?? null;
		lookupCache.set(id, { value, at });
		if (value) result.set(id, value);
	}
	return result;
}

/** `saved`: the returned card is in the library; on failure the local copy stays as it was */
export type PublishOutcome = PublishResult & { saved: Result<true, string> };

/**
 * Uploads a local card. Local pictures go as files, server ones stay as refs.
 * On success the returned card replaces the local one (under a new id if it was a fork).
 */
export async function publishScenario(card: ScenarioCard): Promise<Result<PublishOutcome, string>> {
	const payload = structuredClone(card) as KawaScenarioCard;
	const form = new FormData();
	const slots = [
		["cardPicture", payload.card],
		["chatPicture", payload.chat]
	] as const;
	for (const [slot, holder] of slots) {
		const ref = holder.picture;
		if (!ref || isRemoteRef(ref)) continue;
		const blob = await refToBlob(ref);
		holder.picture = null;
		if (blob) form.append(slot, blob, `${slot}.webp`);
	}
	form.append("card", JSON.stringify(payload));

	const r = await api<PublishResult>("POST", "/api/scenarios", form);
	if (!r.success) return r;

	forgetLookup(card.id);
	forgetLookup(r.value.id);
	const stored = await idb.set("scenarios", r.value.card);
	if (!stored.success)
		return { success: true, value: { ...r.value, saved: { success: false, error: stored.error } } };
	// a fork lives under its own id now; the edited copy of the original would be a stale duplicate
	if (r.value.id !== card.id) await idb.del("scenarios", card.id);
	return { success: true, value: { ...r.value, saved: { success: true, value: true } } };
}

export async function delistScenario(id: string) {
	forgetLookup(id);
	return await api<{ ok: true }>("POST", `/api/scenarios/${encodeURIComponent(id)}/delist`);
}

// ---- tag vocabulary ----

function fetchJSON<T>(url: string) {
	return fetch(url).then(r => r.ok ? r.json() as Promise<T> : Promise.reject(new Error(`status ${r.status}`)));
}

let loading: Promise<TagIndex | null> | null = null;
/** the whole vocabulary with suggestions (web/assets/tags.json, see shared/tags.ts), fetched once; null while it can't be loaded */
export function loadTagIndex() {
	loading ??= fetchJSON<TagSources>("/assets/tags.json")
		.then(makeTagIndex)
		.catch(e => {
			console.warn("tags: can't load the vocabulary", e);
			loading = null; // the next caller tries again
			return null;
		});
	return loading;
}

/*
Labels, aliases and groups only (web/assets/tag-labels.json, preloaded by index.html): enough to show labels and match hidden tags,
so every page can have them without the descriptions and terms. Until it arrives tags show as stored.
*/
let loadingLookup: Promise<TagLookup | null> | null = null;
let lookup: TagLookup | null = null;
const lookupListeners: (() => void)[] = [];
function loadTagLookup() {
	loadingLookup ??= fetchJSON<TagLabels>("/assets/tag-labels.json")
		.then(sources => {
			lookup = makeTagLookup(sources);
			lookupListeners.forEach(cb => cb());
			return lookup;
		})
		.catch(e => {
			console.warn("tags: can't load the labels", e);
			loadingLookup = null;
			return null;
		});
	return loadingLookup;
}
/** how a card tag is shown: its label once the labels have loaded, the stored name until then and for unknown tags */
export function tagLabel(tag: string) {
	if (!lookup) loadTagLookup();
	return lookup?.label(tag) ?? tag;
}
/** fires once the labels arrive, for views rendered before that */
export function onTagLabels(cb: () => void) {
	lookupListeners.push(cb);
}

// ---- hidden content ----

export function localHiddenTags(): string[] {
	try {
		const parsed = JSON.parse(local.get("hiddenTags") ?? "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
export function setLocalHiddenTags(tags: string[]) {
	local.set("hiddenTags", JSON.stringify(tags));
}
export function hiddenTags(): string[] {
	return account.get()?.hiddenTags ?? localHiddenTags();
}
let hiddenSpellings: { key: string, expanded: boolean, names: Set<string> } | null = null;
/**
 * The card tags a hidden tag covers: its own spellings and those of every tag under it, so hiding "violence" covers "gore".
 * Until the labels load, tags match as typed; onHiddenTagsChange listeners hear when they arrive.
 */
export function hiddenMatches(tags: string[]) {
	const hidden = hiddenTags();
	if (hidden.length === 0) return [];
	if (!lookup) loadTagLookup();
	const key = hidden.join(",");
	if (hiddenSpellings?.key !== key || hiddenSpellings.expanded !== Boolean(lookup)) {
		const ix = lookup;
		hiddenSpellings = {
			key,
			expanded: Boolean(ix),
			names: new Set(hidden.flatMap(t => ix ? [...ix.spellings(t)] : normalizeTags([t])))
		};
	}
	const names = hiddenSpellings.names;
	return tags.filter(t => names.has(normalizeTags([t])[0] ?? ""));
}
/** fires when the hidden tags change, and once the labels load (hidden tags then cover more, and cards show labels) */
export function onHiddenTagsChange(cb: () => void) {
	lookupListeners.push(cb);
	account.listen(cb);
	listen(u => {
		if (u.storage === "local" && u.key === "hiddenTags") cb();
	});
}
export function parseTags(raw: string) {
	return normalizeTags(raw.split(","));
}

export function authorNames(authors: UserRef[]) {
	return authors.map(a => a.username).join(", ");
}

export function relativeTime(ts: number) {
	const delta = (Date.now() - ts) / 1000;
	if (delta < 60) return "just now";
	const units: [number, string][] = [[60, "minute"], [3600, "hour"], [86400, "day"], [2592000, "month"], [31536000, "year"]];
	let picked = units[0];
	for (const u of units) if (delta >= u[0]) picked = u;
	const n = Math.floor(delta / picked[0]);
	return `${n} ${picked[1]}${n === 1 ? "" : "s"} ago`;
}
