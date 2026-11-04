/*
The tag vocabulary: known tags, their aliases and the groups that make a tag imply another.
Sources live in shared/tags/ and are edited by hand:
- tags.json:    { categories, tags: { "main name": { label, category, description, terms, common } } }
- aliases.json: { "main name": ["alias", ...] }, true synonyms, rewritten to the main name on publish
- groups.json:  { "parent": ["child", ...] }, a child implies its parent, so filtering or hiding a parent covers its children
`npm run build:tags` checks them with `validateTagSources` and merges them into web/assets/tags.json for the client.
Search terms are loose associations for suggestions only, never for search.
*/
import { normalizeTags } from "./api";

export type TagRecord = {
	/** display name, may carry an emoji */
	label: string,
	category: string,
	description: string,
	/** space separated words suggestions also match on */
	terms: string,
	/** offered first */
	common: boolean
};
export type TagSources = {
	categories: string[],
	tags: Record<string, TagRecord>,
	aliases: Record<string, string[]>,
	groups: Record<string, string[]>
};

export type TagIndex = ReturnType<typeof makeTagIndex>;

/** Lookups over checked sources; unknown tags pass through as themselves */
export function makeTagIndex(src: TagSources) {
	const main = new Map<string, string>();
	Object.keys(src.tags).forEach(t => main.set(t, t));
	Object.entries(src.aliases).forEach(([t, list]) => list.forEach(a => main.set(a, t)));

	const parentsOf = new Map<string, string[]>();
	Object.entries(src.groups).forEach(([parent, children]) => children.forEach(c => {
		parentsOf.set(c, [...(parentsOf.get(c) ?? []), parent]);
	}));

	/** walks a relation transitively; the start is included */
	function walk(start: string, next: (t: string) => string[] | undefined) {
		const seen = new Set([start]);
		const queue = [start];
		while (queue.length) {
			for (const t of next(queue.pop()!) ?? []) {
				if (seen.has(t)) continue;
				seen.add(t);
				queue.push(t);
			}
		}
		return seen;
	}

	/** the main name of a tag or alias, null for unknown tags */
	function canonical(raw: string) {
		const [tag] = normalizeTags([raw]);
		return tag ? main.get(tag) ?? null : null;
	}
	/** normalizes and rewrites aliases to main names; unknown tags stay as they are */
	function canonicalize(tags: string[]) {
		return Array.from(new Set(normalizeTags(tags).map(t => main.get(t) ?? t)));
	}
	/** the tag with every tag it implies, directly or through other groups */
	function implied(tag: string) {
		return walk(canonical(tag) ?? tag, t => parentsOf.get(t));
	}
	/** the tag with every tag under it */
	function covered(tag: string) {
		return walk(canonical(tag) ?? tag, t => src.groups[t]);
	}
	/** every spelling a card tagged with `tag` or anything under it may carry: main names and aliases */
	function spellings(tag: string) {
		const [normal] = normalizeTags([tag]);
		const names = new Set(normal ? [normal] : []);
		covered(tag).forEach(t => {
			names.add(t);
			src.aliases[t]?.forEach(a => names.add(a));
		});
		return names;
	}

	// words each tag is found by, accent-free: [names (main, label, aliases), loose terms]
	let words: Map<string, [names: string[], terms: string[]]> | null = null;
	function searchWords() {
		words ??= new Map(Object.entries(src.tags).map(([name, t]) => {
			const names = [name, plain(t.label), ...(src.aliases[name] ?? [])].map(fold);
			return [name, [names, fold(t.terms).split(/\s+/).filter(w => w)]];
		}));
		return words;
	}
	/**
	 * Known tags for a half-typed `fragment`, best first, skipping `exclude` (main names).
	 * Ranks: exact name or alias, main name prefix, alias or label prefix, whole word of a name, exact term,
	 * word prefix of a name, term prefix. Terms listed earlier rank higher, they are the closer ones.
	 */
	function suggest(fragment: string, exclude: Set<string>, limit: number) {
		const f = fold(normalizeTags([fragment])[0] ?? "");
		if (!f) return [];
		const ranked: [name: string, rank: number][] = [];
		for (const [name, [names, terms]] of searchWords()) {
			if (exclude.has(name)) continue;
			const nameWords = names.flatMap(n => n.split(/[^\p{L}\p{N}]+/u));
			const term = terms.indexOf(f);
			const termPrefix = f.length > 1 ? terms.findIndex(w => w.startsWith(f)) : -1;
			const rank =
				names.includes(f)                       ? 0 :
				names[0].startsWith(f)                  ? 1 :
				names.some(n => n.startsWith(f))        ? 2 :
				nameWords.includes(f)                   ? 3 :
				term >= 0                               ? 4 + term / 100 :
				nameWords.some(w => w.startsWith(f))    ? 5 :
				termPrefix >= 0                         ? 6 + termPrefix / 100 : -1;
			if (rank >= 0) ranked.push([name, rank]);
		}
		const common = (n: string) => src.tags[n].common ? 0 : 1;
		return ranked
			.sort(([a, ra], [b, rb]) => ra - rb || common(a) - common(b) || a.length - b.length || a.localeCompare(b))
			.slice(0, limit)
			.map(([name]) => name);
	}

	return { sources: src, canonical, canonicalize, implied, covered, spellings, suggest };
}

/** a label without its leading emoji, lowercase */
export function plain(label: string) {
	return normalizeTags([label.replace(/^(?:\p{N}️?⃣|[^\p{L}\p{N}])+/u, "")])[0] ?? "";
}
/** accent-free, for matching only */
function fold(s: string) {
	return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Everything wrong with the sources, as readable lines; empty when they are fine */
export function validateTagSources(src: TagSources, maxLength: number): string[] {
	const errors: string[] = [];
	const categories = new Set(src.categories);
	if (categories.size !== src.categories.length) errors.push("categories: duplicate names");

	const checkName = (where: string, name: string) => {
		if (normalizeTags([name])[0] !== name) errors.push(`${where}: "${name}" isn't normalized (lowercase, single spaces, no '#')`);
		if (name.length > maxLength) errors.push(`${where}: "${name}" is longer than ${maxLength} characters`);
	};

	for (const [name, t] of Object.entries(src.tags)) {
		checkName("tags", name);
		if (typeof t.label !== "string" || !t.label.trim()) errors.push(`tags: "${name}" has no label`);
		if (!categories.has(t.category)) errors.push(`tags: "${name}" has an unknown category "${t.category}"`);
		if (typeof t.description !== "string") errors.push(`tags: "${name}" description isn't a string`);
		if (typeof t.terms !== "string") errors.push(`tags: "${name}" terms aren't a string`);
		if (typeof t.common !== "boolean") errors.push(`tags: "${name}" common isn't true or false`);
	}

	const aliasOwner = new Map<string, string>();
	for (const [name, list] of Object.entries(src.aliases)) {
		if (!src.tags[name]) errors.push(`aliases: "${name}" isn't a tag`);
		for (const alias of list) {
			checkName(`aliases of "${name}"`, alias);
			if (src.tags[alias]) errors.push(`aliases: "${alias}" of "${name}" is a tag itself`);
			const owner = aliasOwner.get(alias);
			if (owner) errors.push(`aliases: "${alias}" belongs to both "${owner}" and "${name}"`);
			aliasOwner.set(alias, name);
		}
	}

	for (const [parent, children] of Object.entries(src.groups)) {
		if (!src.tags[parent]) errors.push(`groups: "${parent}" isn't a tag${aliasOwner.has(parent) ? `, it's an alias of "${aliasOwner.get(parent)}"` : ""}`);
		if (new Set(children).size !== children.length) errors.push(`groups: "${parent}" lists a child twice`);
		for (const child of children) {
			if (!src.tags[child]) errors.push(`groups: "${child}" in "${parent}" isn't a tag${aliasOwner.has(child) ? `, it's an alias of "${aliasOwner.get(child)}"` : ""}`);
			if (child === parent) errors.push(`groups: "${parent}" contains itself`);
		}
	}
	// a tag under itself through other groups would make it imply itself forever
	const state = new Map<string, "open" | "done">();
	const visit = (t: string, path: string[]): void => {
		if (state.get(t) === "done") return;
		if (state.get(t) === "open") {
			errors.push(`groups: loop ${[...path.slice(path.indexOf(t)), t].join(" > ")}`);
			return;
		}
		state.set(t, "open");
		src.groups[t]?.forEach(c => visit(c, [...path, t]));
		state.set(t, "done");
	};
	Object.keys(src.groups).forEach(t => visit(t, []));

	return errors;
}
