import { local } from "@root/persist";
import { neatNumber, nothrow } from "@root/utils";
import { mudcrack } from "rampike";
import type { RampikeTabs } from "@rampike/tabs";
import { type DatacatTag, MAX_BLOCKED_TAGS, listTags } from "./datacat-api";

/*
The Datacat browser's blacklist tab: searches leave out characters with the tags picked here.
Datacat knows over a hundred thousand tags, mostly one-off custom ones, so the tab asks for them by name:
the first visit lists the most used ones, the search field finds the rest. Only the picked tags are stored.
*/

export type BlockedTag = { id: number, name: string };

const el = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

export function blockedTags(): BlockedTag[] {
	const raw = local.get("datacatBlocked");
	if (!raw) return [];
	const parsed = nothrow(() => JSON.parse(raw) as unknown);
	return parsed.success && Array.isArray(parsed.value) ? parsed.value : [];
}
function saveBlocked(tags: BlockedTag[]) {
	local.set("datacatBlocked", JSON.stringify(tags));
}

// ---- tab state ----

let onDone: (changed: boolean) => void = () => {};
let changed = false;
/** the last answer, kept while the modal lives so coming back to the tab doesn't ask again */
let results: { query: string, tags: DatacatTag[] } | null = null;
let searchSequence = 0;
let status = "";

export function datacatBlacklistUnit(done: (changed: boolean) => void) {
	onDone = done;
	const filter = el<HTMLInputElement>("#datacat-tags-filter");
	filter.addEventListener("keydown", e => {
		if (e.key === "Enter") search(filter.value);
	});
	el("#datacat-tags-search").addEventListener("click", () => search(filter.value));
	el("#datacat-blacklist-back").addEventListener("click", () => {
		const wasChanged = changed;
		changed = false;
		onDone(wasChanged);
	});
}

/** switches the modal to the blacklist tab; the first visit lists the most used tags */
export function openBlacklist() {
	el<RampikeTabs>("#datacat-tabs").tab = "blacklist";
	status = "";
	render();
	if (!results) search("");
}

/** an empty query lists the most used tags */
async function search(raw: string) {
	const query = raw.trim();
	const run = ++searchSequence;
	status = query ? "Searching Datacat's tags…" : "Asking Datacat for the most used tags…";
	render();
	const r = await listTags(query);
	if (run !== searchSequence) return;
	if (!r.success) {
		status = `Can't get the tags: ${r.error}`;
		return render();
	}
	results = { query, tags: r.value };
	status = "";
	render();
}

function toggle(tag: BlockedTag) {
	const blocked = blockedTags();
	const ix = blocked.findIndex(t => t.id === tag.id);
	if (ix !== -1) {
		blocked.splice(ix, 1);
	} else if (blocked.length >= MAX_BLOCKED_TAGS) {
		status = `Datacat leaves out at most ${MAX_BLOCKED_TAGS} tags per search: unblock some first`;
		return render();
	} else {
		blocked.push({ id: tag.id, name: tag.name });
	}
	saveBlocked(blocked);
	changed = true;
	status = "";
	render();
}

// ---- rendering ----

function render() {
	const blocked = blockedTags();
	const blockedIds = new Set(blocked.map(t => t.id));

	el("#datacat-blocked-count").textContent = `${blocked.length}/${MAX_BLOCKED_TAGS}`;
	el("#datacat-blocked").replaceChildren(...(blocked.length > 0
		? blocked.map(tag => mudcrack({
			tagName: "button",
			className: "kawa-chip datacat-tag pointer",
			attributes: { "aria-pressed": "true", title: "unblock" },
			contents: `${tag.name} ✕`,
			events: { click: () => toggle(tag) }
		}))
		: [mudcrack({ tagName: "div", className: "hint", contents: "Nothing is blocked" })]
	));

	el("#datacat-tags").replaceChildren(...(results?.tags ?? []).map(tag => mudcrack({
		tagName: "button",
		className: "kawa-chip datacat-tag pointer",
		attributes: { "aria-pressed": String(blockedIds.has(tag.id)), title: `${tag.count} characters` },
		contents: [tag.name, mudcrack({ tagName: "span", className: "hint", contents: ` ${neatNumber(tag.count)}` })],
		events: { click: () => toggle(tag) }
	})));

	el("#datacat-tags-status").textContent = status || describe();
}

function describe() {
	if (!results) return "";
	if (!results.query) return "The most used tags; search for the rest";
	return results.tags.length > 0 ? `Tags matching "${results.query}", most used first` : `Datacat has no tags matching "${results.query}"`;
}
