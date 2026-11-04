import { sql, type Kysely } from "kysely";
import type {
	KawaScenarioCard,
	Page,
	ScenarioListItem,
	ScenarioMeta,
	ScenarioSort,
	SearchField,
	SiteStats,
	UserRef,
	Vote
} from "@shared/api";
import { PER_PAGE } from "@shared/api";
import { config } from "./config";
import { db, foreignDataVersion } from "./db";
import type { Database, ScenarioRow } from "./db/schema";
import { mediaUrl, readPictureBase64 } from "./media";
import { tagIndex } from "./tags";
import { profileUrl, usersById } from "./users";
import { makePage, parseJSON } from "./util";

/*
Scenario catalog: listing, search, serialization and the search index.
Stored card JSON keeps pictures as media hashes and has no author fields; both are resolved when served,
so username changes and host changes propagate without rewriting rows.
*/

const SORT_COLUMN = {
	updated:   "updated_at",
	published: "published_at",
	score:     "score"
} as const;
const FTS_COLUMN: Record<SearchField, string> = {
	title:       "title",
	description: "description",
	tags:        "tags",
	character:   "character",
	authors:     "authors",
	definition:  "definition",
	openings:    "openings"
};
export const SEARCH_FIELDS = Object.keys(FTS_COLUMN) as SearchField[];

// ---- homepage cache ----

let homeCache: Page<ScenarioListItem> | null = null;
let statsCache: SiteStats | null = null;
/** every mutation that can change the listing or the counters goes through here */
export function invalidateHome() {
	homeCache = null;
	statsCache = null;
}
// writes from other processes (cli retag) skip invalidateHome; sqlite's data version tells about them
let cachedVersion = foreignDataVersion();
function dropIfChangedElsewhere() {
	const version = foreignDataVersion();
	if (version === cachedVersion) return;
	cachedVersion = version;
	invalidateHome();
}
export async function homePage() {
	dropIfChangedElsewhere();
	if (!homeCache) homeCache = await listScenarios({ sort: "updated", page: 0, query: "", fields: SEARCH_FIELDS, tag: null });
	return homeCache;
}
export async function siteStats(): Promise<SiteStats> {
	dropIfChangedElsewhere();
	if (statsCache) return statsCache;
	const count = (q: { executeTakeFirstOrThrow: () => Promise<{ n: number }> }) => q.executeTakeFirstOrThrow().then(r => r.n);
	const n = sql<number>`count(*)`.as("n");
	const [scenarios, creators, comments] = await Promise.all([
		count(db.selectFrom("scenarios").select(n).where("delisted_at", "is", null)),
		count(db.selectFrom("users").select(n).where("is_creator", "=", 1)),
		count(db.selectFrom("comments").select(n))
	]);
	statsCache = { scenarios, creators, comments };
	return statsCache;
}

// ---- serialization ----

export function rowAuthors(row: Pick<ScenarioRow, "authors">) {
	return parseJSON<string[]>(row.authors, []);
}

export async function authorsFor(rows: Pick<ScenarioRow, "authors">[]) {
	return await usersById(rows.flatMap(rowAuthors));
}

export function toListItem(row: ScenarioRow, users: Map<string, UserRef>): ScenarioListItem {
	return {
		id: row.id,
		title: row.title,
		snippet: row.snippet,
		tags: parseJSON<string[]>(row.tags, []),
		picture: mediaUrl(row.card_picture),
		characterName: row.character_name,
		tokenCount: row.token_count,
		authors: rowAuthors(row).map(id => users.get(id)).filter(u => u) as UserRef[],
		score: row.score,
		commentCount: row.comment_count,
		publishedAt: row.published_at,
		updatedAt: row.updated_at
	};
}

export function toMeta(row: ScenarioRow, users: Map<string, UserRef>, myVote: Vote): ScenarioMeta {
	return {
		...toListItem(row, users),
		ownerId: row.owner_id,
		parentId: row.parent_id,
		delisted: row.delisted_at !== null,
		myVote
	};
}

/** Full Ägir-compatible card as served to clients */
export async function toCard(row: ScenarioRow, users: Map<string, UserRef>, inline = false): Promise<KawaScenarioCard> {
	const card = parseJSON<KawaScenarioCard>(row.data, null as any);
	const authors = rowAuthors(row).map(id => users.get(id)).filter(u => u) as UserRef[];
	const owner = users.get(row.owner_id);
	const absolute = (path: string) => `${config.publicUrl}${path}`;

	card.id = row.id;
	card.lastUpdate = row.updated_at;
	card.card.picture = inline ? await readPictureBase64(row.card_picture) : mediaUrl(row.card_picture);
	card.chat.picture = inline ? await readPictureBase64(row.chat_picture) : mediaUrl(row.chat_picture);
	card.card.author = owner
		? { name: owner.username, url: absolute(profileUrl(owner.username)) }
		: null;
	card["kawa-authors"] = authors.map(a => ({ name: a.username, url: absolute(profileUrl(a.username)) }));
	return card;
}

// ---- listing & search ----

export type ListOptions = {
	sort: ScenarioSort,
	page: number,
	query: string,
	fields: SearchField[],
	tag: string | null
};

/** User input -> FTS5 match expression: every word must match as a prefix within the picked columns */
function ftsExpression(query: string, fields: SearchField[]) {
	const terms = query
		.split(/\s+/)
		.map(t => t.replace(/["*^:(){}]/g, "").trim())
		.filter(t => t)
		.slice(0, 16)
		.map(t => `"${t}"*`);
	if (terms.length === 0) return null;
	const columns = (fields.length ? fields : SEARCH_FIELDS).map(f => FTS_COLUMN[f]).join(" ");
	return `{${columns}} : (${terms.join(" ")})`;
}

export async function listScenarios(o: ListOptions): Promise<Page<ScenarioListItem>> {
	const match = o.query ? ftsExpression(o.query, o.fields) : null;
	let base = db.selectFrom("scenarios").where("delisted_at", "is", null);
	if (match)
		base = base.where(sql<boolean>`scenarios.id in (select id from scenarios_fts where scenarios_fts match ${match})`);
	if (o.tag) {
		// the tag, its aliases and everything under it: filtering by "violence" finds cards tagged "gore"
		const names = [...tagIndex.spellings(o.tag)];
		if (names.length)
			base = base.where(sql<boolean>`exists (select 1 from json_each(scenarios.tags) where lower(json_each.value) in (${sql.join(names)}))`);
	}

	const [{ total }, rows] = await Promise.all([
		base.select(sql<number>`count(*)`.as("total")).executeTakeFirstOrThrow(),
		base
			.selectAll()
			.orderBy(SORT_COLUMN[o.sort], "desc")
			.orderBy("updated_at", "desc")
			.limit(PER_PAGE)
			.offset(o.page * PER_PAGE)
			.execute()
	]);
	const users = await authorsFor(rows);
	return makePage(rows.map(r => toListItem(r, users)), o.page, total);
}

// ---- search index ----

type Trx = Kysely<Database>;

export async function indexScenario(trx: Trx, row: Pick<ScenarioRow, "id" | "data" | "authors" | "delisted_at">) {
	await unindexScenario(trx, row.id);
	if (row.delisted_at) return;

	const card = parseJSON<KawaScenarioCard | null>(row.data, null);
	if (!card) return;
	const users = await trx
		.selectFrom("users")
		.select(["id", "username"])
		.where("id", "in", rowAuthors(row).length ? rowAuthors(row) : [""])
		.execute();
	await sql`insert into scenarios_fts (id, title, description, tags, character, authors, definition, openings)
		values (
			${row.id},
			${card.card.title},
			${card.card.description},
			${card.card.tags.join(" ")},
			${card.chat.name},
			${users.map(u => u.username).join(" ")},
			${card.chat.definition},
			${card.chat.initials.join("\n")}
		)`.execute(trx);
}

export async function unindexScenario(trx: Trx, id: string) {
	await sql`delete from scenarios_fts where id = ${id}`.execute(trx);
}

export type RetagChange = { id: string, title: string, from: string[], to: string[] };
/**
 * Runs every stored card's tags (delisted ones too) through the current vocabulary, as publishing does:
 * aliases become main names, duplicates go. Updates the tags column, the card data and the search index,
 * leaving `updated_at` and the card's `lastUpdate` alone. With `dryRun` it only reports.
 * A running server keeps its cached home page until its next publish or restart.
 */
export async function retagScenarios(dryRun: boolean) {
	const rows = await db.selectFrom("scenarios").select(["id", "title", "tags", "data", "authors", "delisted_at"]).execute();
	const changes: (RetagChange & { row: typeof rows[number], card: KawaScenarioCard })[] = [];
	for (const row of rows) {
		const card = parseJSON<KawaScenarioCard | null>(row.data, null);
		const from = card?.card?.tags ?? parseJSON<string[]>(row.tags, []);
		const to = tagIndex.canonicalize(from);
		const column = parseJSON<string[]>(row.tags, []);
		if (!card || (sameTags(from, to) && sameTags(column, to))) continue;
		changes.push({ id: row.id, title: row.title, from, to, row, card });
	}
	if (!dryRun && changes.length) {
		await db.transaction().execute(async trx => {
			for (const { row, card, to } of changes) {
				card.card.tags = to;
				const data = JSON.stringify(card);
				await trx.updateTable("scenarios").set({ tags: JSON.stringify(to), data }).where("id", "=", row.id).execute();
				await indexScenario(trx, { ...row, data });
			}
		});
	}
	return { checked: rows.length, changes: changes.map(({ id, title, from, to }) => ({ id, title, from, to })) };
}
function sameTags(a: string[], b: string[]) {
	return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** After a rename: refresh the index rows that mention the user as an author */
export async function reindexAuthor(userId: string) {
	const rows = await db
		.selectFrom("scenarios")
		.select(["id", "data", "authors", "delisted_at"])
		.where(sql<boolean>`exists (select 1 from json_each(scenarios.authors) where json_each.value = ${userId})`)
		.execute();
	await db.transaction().execute(async trx => {
		for (const row of rows) await indexScenario(trx, row);
	});
	invalidateHome();
}
