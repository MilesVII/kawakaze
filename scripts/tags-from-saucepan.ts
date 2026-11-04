/*
One-off: converts saucepan_tags.json (repo root) into the hand-edited sources in shared/tags/.
Overwrites them, so it's only for starting over:
	npx esbuild scripts/tags-from-saucepan.ts --bundle --platform=node --format=esm --log-level=warning --outfile=dist/tags-from-saucepan.js && node dist/tags-from-saucepan.js

- main name: the display name without its emoji when that is a plain phrase ("👭 Polyamory" → "polyamory"),
  Saucepan's key otherwise ("👨‍❤️‍👨 Gay (M4M)" → "mlm", "👨 MalePOV" → "male pov")
- aliases: the key, the display name and its parts ("hurt/comfort", "hurt", "comfort"), hyphen and accent variants;
  spellings that clash with a main name or with another tag's alias are dropped and reported
- groups: Saucepan's children lists
*/
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { normalizeTags } from "../shared/api";
import type { TagRecord } from "../shared/tags";

type SaucepanTag = {
	pretty_name: string,
	description: string,
	category: string,
	search_terms: string | null,
	common: boolean,
	parent: string | null,
	children: string[]
};
const input = JSON.parse(readFileSync("saucepan_tags.json", "utf8")) as { categories: string[], tags: Record<string, SaucepanTag> };
const entries = Object.entries(input.tags);
const norm = (s: string) => normalizeTags([s])[0] ?? "";

/** display name without the leading emoji (keycap digits included) */
const plainLabel = (t: SaucepanTag) => norm(t.pretty_name.replace(/^(?:\p{N}️?⃣|[^\p{L}\p{N}])+/u, ""));
const keyName = (key: string) => norm(key.replace(/_/g, " "));
/** a label usable as a tag: words, hyphens and apostrophes, not glued like "MalePOV" */
const plainPhrase = (t: SaucepanTag) =>
	/^[\p{L}\p{N}' -]+$/u.test(plainLabel(t)) && !/\p{Ll}\p{Lu}|\p{Lu}{2}\p{Ll}/u.test(t.pretty_name);

// main names, falling back to keys where two labels would collide
const mainOf = new Map(entries.map(([key, t]) => [key, plainPhrase(t) ? plainLabel(t) : keyName(key)]));
const labelUses = new Map<string, number>();
mainOf.forEach(n => labelUses.set(n, (labelUses.get(n) ?? 0) + 1));
mainOf.forEach((n, key) => { if (labelUses.get(n)! > 1) mainOf.set(key, keyName(key)); });
const mains = new Set(mainOf.values());
if (mains.size !== mainOf.size) throw new Error("main names still collide");

const stripAccents = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");
function spellings(key: string, t: SaucepanTag) {
	const label = plainLabel(t);
	const out = new Set([keyName(key), label]);
	label.split("/").forEach(p => out.add(p));
	const paren = label.match(/^(.*?)\s*\((.+)\)$/);
	if (paren) out.add(paren[1]).add(paren[2]);
	for (const s of [...out]) {
		if (s.includes("-")) out.add(s.replace(/-/g, " ")).add(s.replace(/-/g, ""));
		out.add(stripAccents(s));
	}
	return [...out].map(norm).filter(s => s && s !== mainOf.get(key));
}

// a spelling claimed by two tags, or equal to some tag's main name, is no alias
const claims = new Map<string, string[]>();
entries.forEach(([key, t]) => spellings(key, t).forEach(s => claims.set(s, [...(claims.get(s) ?? []), mainOf.get(key)!])));
const dropped: string[] = [];
const aliases: Record<string, string[]> = {};
claims.forEach((owners, s) => {
	const unique = [...new Set(owners)];
	if (mains.has(s)) return dropped.push(`"${s}" (wanted by ${unique.join(", ")}) is a main name`);
	if (unique.length > 1) return dropped.push(`"${s}" is wanted by ${unique.join(", ")}`);
	(aliases[unique[0]] ??= []).push(s);
});

const tags: Record<string, TagRecord> = {};
const groups: Record<string, string[]> = {};
entries.forEach(([key, t]) => {
	const name = mainOf.get(key)!;
	tags[name] = {
		label: t.pretty_name,
		category: t.category,
		description: t.description ?? "",
		terms: t.search_terms ?? "",
		common: Boolean(t.common)
	};
	if (t.children.length) groups[name] = t.children.map(c => mainOf.get(c)!);
});
// aliases in tag order, so the file reads like tags.json
const orderedAliases = Object.fromEntries(Object.keys(tags).filter(n => aliases[n]).map(n => [n, aliases[n]]));

/** one key per line: these files are edited a line at a time */
const lineMap = (map: Record<string, string[]>) =>
	`{\n${Object.entries(map).map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n}\n`;

mkdirSync("shared/tags", { recursive: true });
writeFileSync("shared/tags/tags.json", JSON.stringify({ categories: input.categories, tags }, null, "\t") + "\n");
writeFileSync("shared/tags/aliases.json", lineMap(orderedAliases));
writeFileSync("shared/tags/groups.json", lineMap(groups));

const renamed = entries.filter(([key]) => mainOf.get(key) !== keyName(key)).map(([key]) => `${keyName(key)} → ${mainOf.get(key)}`);
console.log(`${entries.length} tags, ${Object.values(orderedAliases).flat().length} aliases, ${Object.keys(groups).length} groups`);
console.log(`\nmain names taken from labels (${renamed.length}):\n  ${renamed.join("\n  ")}`);
console.log(`\ndropped aliases (${dropped.length}):\n  ${dropped.join("\n  ")}`);
