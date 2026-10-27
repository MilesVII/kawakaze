import { sql, type Kysely } from "kysely";
import type {
	KawaScenarioCard,
	Page,
	ScenarioListItem,
	ScenarioMeta,
	ScenarioSort,
	SearchField,
	UserRef,
	Vote
} from "@shared/api";
import { PER_PAGE } from "@shared/api";
import { config } from "./config";
import { db } from "./db";
import type { Database, ScenarioRow } from "./db/schema";
import { mediaUrl, readPictureBase64 } from "./media";
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
export function invalidateHome() {
	homeCache = null;
}
export async function homePage() {
	if (!homeCache) homeCache = await listScenarios({ sort: "updated", page: 0, query: "", fields: SEARCH_FIELDS, tag: null });
	return homeCache;
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
	if (o.tag)
		base = base.where(sql<boolean>`exists (select 1 from json_each(scenarios.tags) where lower(json_each.value) = lower(${o.tag}))`);

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
