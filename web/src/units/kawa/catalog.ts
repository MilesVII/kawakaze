import type { KawaScenarioCard, PublishResult, ScenarioLookup, UserRef } from "@shared/api";
import { account, api } from "@root/api";
import { refToBlob } from "@root/media";
import { idb, isRemoteRef, listen, local } from "@root/persist";
import type { Result, ScenarioCard } from "@root/types";

/*
Glue between the local library and the server catalog:
downloading cards, publishing and delisting them, and the hidden-content tag list.
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
	await idb.set("scenarios", r.value);
	return r;
}

export async function lookupScenarios(ids: string[]): Promise<Map<string, ScenarioLookup>> {
	if (ids.length === 0) return new Map();
	const r = await api<{ items: ScenarioLookup[] }>("POST", "/api/scenarios/lookup", { ids });
	if (!r.success) return new Map();
	return new Map(r.value.items.map(i => [i.id, i]));
}

/**
 * Uploads a local card. Local pictures go as files, server ones stay as refs.
 * On success the returned card replaces the local one (under a new id if it was a fork).
 */
export async function publishScenario(card: ScenarioCard): Promise<Result<PublishResult, string>> {
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

	if (r.value.id !== card.id) await idb.del("scenarios", card.id);
	await idb.set("scenarios", r.value.card);
	return r;
}

export async function delistScenario(id: string) {
	return await api<{ ok: true }>("POST", `/api/scenarios/${encodeURIComponent(id)}/delist`);
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
export function hiddenMatches(tags: string[]) {
	const hidden = new Set(hiddenTags().map(t => t.toLowerCase()));
	return tags.filter(t => hidden.has(t.toLowerCase()));
}
export function onHiddenTagsChange(cb: () => void) {
	account.listen(cb);
	listen(u => {
		if (u.storage === "local" && u.key === "hiddenTags") cb();
	});
}
export function parseTags(raw: string) {
	return Array.from(new Set(raw.split(",").map(t => t.trim()).filter(t => t)));
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
