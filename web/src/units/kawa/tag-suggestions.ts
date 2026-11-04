import { normalizeTags } from "@shared/api";
import type { TagIndex } from "@shared/tags";
import { mudcrack } from "rampike";
import { loadTagIndex } from "./catalog";

/*
A row of tag buttons under a comma separated tag field, shown while the field has focus:
- while a tag is being typed: known tags matching it (names, aliases, labels, then search terms);
  a click or Tab puts the main name in place of the half-typed one
- between tags: aliases the field holds, offered as their main names; tags the vocabulary doesn't know;
  then a nudge: common tags of the first category the card doesn't cover yet,
  or content warnings for hidden-tag fields
The vocabulary (web/assets/tags.json, see shared/tags.ts) loads on the first focus.
*/

export type TagFieldKind = "card" | "hidden";

const LIMIT = 8;
const HIDDEN_CATEGORY = "Content Warnings";
const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

type Segment = { start: number, end: number, tag: string };
/** the comma separated parts of `text` with their bounds and normalized tag ("" for blank parts) */
function segments(text: string): Segment[] {
	const out: Segment[] = [];
	let start = 0;
	for (const part of text.split(",")) {
		out.push({ start, end: start + part.length, tag: normalizeTags([part])[0] ?? "" });
		start += part.length + 1;
	}
	return out;
}

export function attachTagSuggestions(input: HTMLTextAreaElement, kind: TagFieldKind) {
	const row = mudcrack({ className: "row-wrap align-center" });
	row.hidden = true;
	(input.closest("fieldset") ?? input).after(row);

	let index: TagIndex | null = null;
	let hideTimer = 0;
	/** what Tab accepts: the first match for the tag being typed */
	let first: (() => void) | null = null;
	/** nudge categories the user skipped, until the page reloads */
	const skipped = new Set<string>();

	// buttons don't take focus, so the field keeps its caret
	row.addEventListener("mousedown", e => e.preventDefault());
	input.addEventListener("focus", async () => {
		clearTimeout(hideTimer);
		index ??= await loadTagIndex();
		update();
	});
	input.addEventListener("blur", () => hideTimer = window.setTimeout(() => row.hidden = true, 150));
	input.addEventListener("input", update);
	input.addEventListener("click", update);
	input.addEventListener("keyup", e => { if (NAVIGATION_KEYS.has(e.key)) update(); });
	input.addEventListener("keydown", e => {
		if (row.hidden) return;
		if (e.key === "Escape") {
			row.hidden = true;
			e.stopPropagation();
		} else if (e.key === "Tab" && !e.shiftKey && first) {
			e.preventDefault();
			first();
		}
	});

	/**
	 * Puts `name` in place of the text between `start` and `end`, keeping one space after commas.
	 * The caret lands after it, or at the end with `toEnd`: hints fix earlier tags while the caret waits there.
	 */
	function replace(start: number, end: number, name: string, toEnd = false) {
		const text = input.value;
		const before = text.slice(0, start) + (start > 0 ? " " : "") + name;
		const after = text.slice(end);
		input.value = before + (after || ", ");
		const caret = toEnd ? input.value.length : before.length + (after ? 0 : 2);
		input.setSelectionRange(caret, caret);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}

	function chip(ix: TagIndex, name: string, onClick: () => void, from?: string) {
		const t = ix.sources.tags[name];
		const emoji = t.label.match(/^[^\p{L}\p{N}]*(?:\p{N}️?⃣[^\p{L}\p{N}]*)?/u)?.[0] ?? "";
		return mudcrack({
			tagName: "button",
			className: "strip ghost pointer no-shrink",
			attributes: { type: "button", title: `${t.label} · ${t.category}\n${t.description}` },
			contents: `${from ? `${from} → ` : ""}${emoji}${name}`,
			events: { click: onClick }
		});
	}
	const caption = (text: string) => mudcrack({ tagName: "span", className: "hint", contents: text });

	function update() {
		first = null;
		const ix = index;
		if (!ix || document.activeElement !== input) {
			row.hidden = true;
			return;
		}
		const text = input.value;
		const caret = input.selectionStart ?? text.length;
		const parts = segments(text);
		const current = parts.find(p => caret >= p.start && caret <= p.end)!;
		const others = parts.filter(p => p !== current && p.tag);
		const present = new Set(others.map(p => ix.canonical(p.tag) ?? p.tag));
		const contents: (HTMLElement | string)[] = [];

		if (current.tag) {
			// a finished main name needn't suggest itself; an alias still offers its main name
			const exclude = new Set(present);
			if (ix.sources.tags[current.tag]) exclude.add(current.tag);
			const matches = ix.suggest(current.tag, exclude, LIMIT);
			matches.forEach((name, i) => {
				const pick = () => replace(current.start, current.end, name);
				if (i === 0) first = pick;
				contents.push(chip(ix, name, pick));
			});
		} else {
			const aliased = others.filter(p => ix.canonical(p.tag) && ix.canonical(p.tag) !== p.tag);
			aliased.forEach(p => contents.push(chip(ix, ix.canonical(p.tag)!, () => replace(p.start, p.end, ix.canonical(p.tag)!, true), p.tag)));

			const unknown = others.filter(p => !ix.canonical(p.tag)).map(p => p.tag);
			if (unknown.length) contents.push(caption(`not in the tag list: ${unknown.join(", ")}`));

			const nudge = kind === "hidden" ? hiddenNudge(ix, present, skipped) : cardNudge(ix, present, skipped);
			if (nudge) {
				contents.push(caption(`${nudge.category}:`));
				nudge.names.forEach(name => contents.push(chip(ix, name, () => {
					// appended at the end, wherever the caret is ("a, , b" has its blank part in the middle)
					if (segments(input.value).at(-1)!.tag) input.value += ",";
					const tail = segments(input.value).at(-1)!;
					replace(tail.start, tail.end, name, true);
				})));
				contents.push(mudcrack({
					tagName: "button",
					className: "strip ghost pointer no-shrink",
					attributes: { type: "button", title: kind === "hidden" ? "stop suggesting these" : "suggest another category" },
					contents: "skip",
					events: { click: () => { skipped.add(nudge.category); update(); } }
				}));
			}
		}

		row.replaceChildren(...contents);
		row.hidden = contents.length === 0;
	}
}

/** common tags of the first category none of the card's tags belong to and the user didn't skip */
function cardNudge(ix: TagIndex, present: Set<string>, skipped: Set<string>) {
	const { tags, categories } = ix.sources;
	const covered = new Set([...present].flatMap(n => tags[n] ? [tags[n].category] : []));
	for (const category of categories) {
		if (covered.has(category) || skipped.has(category)) continue;
		const names = Object.keys(tags).filter(n => tags[n].category === category && tags[n].common && !present.has(n));
		if (names.length) return { category, names: names.slice(0, LIMIT) };
	}
	return null;
}
/** content warnings not hidden yet, common first, unless skipped */
function hiddenNudge(ix: TagIndex, present: Set<string>, skipped: Set<string>) {
	if (skipped.has(HIDDEN_CATEGORY)) return null;
	const { tags } = ix.sources;
	const names = Object.keys(tags)
		.filter(n => tags[n].category === HIDDEN_CATEGORY && !present.has(n))
		.sort((a, b) => Number(tags[b].common) - Number(tags[a].common));
	return names.length ? { category: HIDDEN_CATEGORY, names: names.slice(0, LIMIT) } : null;
}
