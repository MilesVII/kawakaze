/*
Checks the hand-edited tag sources in shared/tags/ and merges them into web/assets/tags.json for the client.
Runs as `npm run build:tags` (part of `npm run build`); exits with 1 and writes nothing when something is wrong.
*/
import { readFileSync, writeFileSync } from "node:fs";
import { LIMITS } from "../shared/api";
import { validateTagSources, type TagSources } from "../shared/tags";

const DIR = "shared/tags/";
const OUT = "web/assets/tags.json";

function read(file: string): unknown {
	try {
		return JSON.parse(readFileSync(DIR + file, "utf8"));
	} catch (e: any) {
		fail([`${DIR}${file}: ${e?.message ?? e}`]);
	}
}
function fail(errors: string[]): never {
	console.error(`tags: ${errors.length} problem${errors.length > 1 ? "s" : ""}\n  ${errors.join("\n  ")}`);
	process.exit(1);
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string");

const main = read("tags.json");
const aliases = read("aliases.json");
const groups = read("groups.json");

// shape first: validateTagSources trusts the types
const shape: string[] = [];
if (!isObject(main) || !isStringArray(main.categories) || !isObject(main.tags) || !Object.values(main.tags).every(isObject))
	shape.push(`${DIR}tags.json: expected { "categories": [...], "tags": { "name": { ... } } }`);
if (!isObject(aliases) || !Object.values(aliases).every(isStringArray))
	shape.push(`${DIR}aliases.json: expected { "tag": ["alias", ...] }`);
if (!isObject(groups) || !Object.values(groups).every(isStringArray))
	shape.push(`${DIR}groups.json: expected { "parent": ["child", ...] }`);
if (shape.length) fail(shape);

const sources = { ...(main as Pick<TagSources, "categories" | "tags">), aliases, groups } as TagSources;
const errors = validateTagSources(sources, LIMITS.tagLength);
if (errors.length) fail(errors);

writeFileSync(OUT, JSON.stringify(sources));
const count = (m: Record<string, string[]>) => Object.values(m).flat().length;
console.log(`tags: ${Object.keys(sources.tags).length} tags, ${count(sources.aliases)} aliases, ${count(sources.groups)} implications → ${OUT}`);
