import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "kysely";
import type { KawaScenarioCard, PublishResult, ScenarioLookup, ScenarioSort, SearchField } from "@shared/api";
import { LIMITS, normalizeTags } from "@shared/api";
import { requireCreator, requireUser, type AppEnv } from "../auth";
import {
	SEARCH_FIELDS,
	authorsFor,
	homePage,
	indexScenario,
	invalidateHome,
	siteStats,
	listScenarios,
	rowAuthors,
	toCard,
	toMeta,
	unindexScenario
} from "../catalog";
import { db } from "../db";
import type { ScenarioRow } from "../db/schema";
import { mediaExists, parseMediaUrl, storePicture } from "../media";
import { ID_RE, clampVote, ensure, fail, isString, isStringArray, pageParam, readJSON } from "../util";

export const scenarioRoutes = new Hono<AppEnv>();

const SORTS: ScenarioSort[] = ["updated", "published", "score"];

scenarioRoutes.get("/", async c => {
	const sort = SORTS.includes(c.req.query("sort") as ScenarioSort) ? c.req.query("sort") as ScenarioSort : "updated";
	const query = (c.req.query("q") ?? "").trim().slice(0, 200);
	const fieldsParam = c.req.query("fields");
	const fields = fieldsParam
		? fieldsParam.split(",").filter(f => SEARCH_FIELDS.includes(f as SearchField)) as SearchField[]
		: SEARCH_FIELDS;
	const tag = c.req.query("tag")?.trim() || null;
	const page = pageParam(c);

	if (sort === "updated" && !query && !tag && page === 0) return c.json(await homePage());
	return c.json(await listScenarios({ sort, page, query, fields, tag }));
});

scenarioRoutes.get("/stats", async c => c.json(await siteStats()));

scenarioRoutes.post("/lookup", async c => {
	const body = await readJSON(c);
	const ids = isStringArray(body?.ids) ? body.ids.slice(0, 1000) : fail(400, "ids required");
	if (ids.length === 0) return c.json({ items: [] });
	const rows = await db
		.selectFrom("scenarios")
		.select(["id", "updated_at", "owner_id", "delisted_at"])
		.where("id", "in", ids)
		.execute();
	const items: ScenarioLookup[] = rows.map(r => ({
		id: r.id,
		updatedAt: r.updated_at,
		ownerId: r.owner_id,
		delisted: r.delisted_at !== null
	}));
	return c.json({ items });
});

async function getRow(id: string) {
	return await db.selectFrom("scenarios").selectAll().where("id", "=", id).executeTakeFirst();
}

scenarioRoutes.get("/:id", cors({ origin: "*" }), async c => {
	const row = ensure(await getRow(c.req.param("id")), 404, "scenario not found");
	if (row.delisted_at) fail(410, "scenario is delisted");
	const users = await authorsFor([{ authors: JSON.stringify([...rowAuthors(row), row.owner_id]) }]);
	const inline = ["1", "true"].includes(c.req.query("inline") ?? "");
	c.header("Cache-Control", "public, max-age=60");
	return c.json(await toCard(row, users, inline));
});

scenarioRoutes.get("/:id/meta", async c => {
	const row = ensure(await getRow(c.req.param("id")), 404, "scenario not found");
	const user = c.get("user");
	const canSee = !row.delisted_at || (user && (user.id === row.owner_id || user.is_admin));
	if (!canSee) fail(410, "scenario is delisted");
	const users = await authorsFor([row]);
	const vote = user
		? await db
			.selectFrom("scenario_votes")
			.select("value")
			.where("user_id", "=", user.id)
			.where("scenario_id", "=", row.id)
			.executeTakeFirst()
		: undefined;
	return c.json(toMeta(row, users, clampVote(vote?.value)));
});

/** Validates a card from a publish request; returns a copy safe to store (pictures still unresolved) */
function validateCard(raw: unknown): KawaScenarioCard {
	const card = raw as KawaScenarioCard;
	if (!card || typeof card !== "object") fail(400, "card must be an object");
	if (!isString(card.id) || !ID_RE.test(card.id)) fail(400, "invalid card id");
	if (!card.card || typeof card.card !== "object") fail(400, "card.card is required");
	if (!card.chat || typeof card.chat !== "object") fail(400, "card.chat is required");

	const title = isString(card.card.title) ? card.card.title.trim() : "";
	if (!title) fail(400, "card title is required");
	if (title.length > LIMITS.title) fail(400, "card title is too long");
	if (!isString(card.card.description)) fail(400, "card description must be a string");

	const tags = isStringArray(card.card.tags) ? normalizeTags(card.card.tags) : [];
	if (tags.length > LIMITS.tags) fail(400, `at most ${LIMITS.tags} tags`);
	if (tags.some(t => t.length > LIMITS.tagLength)) fail(400, "tag is too long");

	if (!isString(card.chat.name)) fail(400, "character name must be a string");
	if (!isString(card.chat.definition) || !card.chat.definition.trim()) fail(400, "character definition is required");
	if (!isStringArray(card.chat.initials) || !card.chat.initials.some(m => m.trim()))
		fail(400, "at least one opening message is required");
	if (card.lorebooks !== undefined && !Array.isArray(card.lorebooks)) fail(400, "lorebooks must be an array");

	const summary = isString(card["kawa-snippet"]?.summary) ? card["kawa-snippet"]!.summary.trim() : "";
	if (!summary) fail(400, "snippet is required to publish");
	if (summary.length > LIMITS.snippet) fail(400, `snippet is limited to ${LIMITS.snippet} characters`);

	const tokenCount = Number(card.chat.tokenCount);
	const copy: KawaScenarioCard = {
		...card,
		card: { ...card.card, title, tags, author: null },
		chat: {
			...card.chat,
			initials: card.chat.initials.filter(m => m.trim()),
			tokenCount: Number.isFinite(tokenCount) && tokenCount >= 0 ? Math.round(tokenCount) : 0
		},
		"kawa-snippet": { summary }
	};
	delete copy["kawa-authors"];
	return copy;
}

/** A picture part replaces the ref; otherwise the ref must be null or one of our media URLs */
async function resolvePicture(file: unknown, ref: string | null, ownerId: string) {
	if (file instanceof File && file.size > 0) return await storePicture(file, ownerId);
	if (!ref) return null;
	const hash = parseMediaUrl(ref);
	if (!hash || !(await mediaExists(hash))) fail(400, "pictures must be uploaded with the card");
	return hash;
}

scenarioRoutes.post("/", async c => {
	const user = requireCreator(c);
	const body = await c.req.parseBody();
	const rawCard = ensure(isString(body.card) ? body.card : null, 400, "card is required");
	if (Buffer.byteLength(rawCard) > LIMITS.cardBytes) fail(413, "card is too large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawCard);
	} catch {
		fail(400, "card is not valid JSON");
	}
	const card = validateCard(parsed);

	const cardPicture = await resolvePicture(body.cardPicture, card.card.picture, user.id);
	const chatPicture = await resolvePicture(body.chatPicture, card.chat.picture, user.id);

	const existing = await getRow(card.id);
	const forked = Boolean(existing && existing.owner_id !== user.id);
	const now = Date.now();
	const id = forked ? crypto.randomUUID() : card.id;
	const authors = existing
		? forked
			? Array.from(new Set([...rowAuthors(existing), user.id]))
			: rowAuthors(existing)
		: [user.id];

	card.id = id;
	card.lastUpdate = now;
	card.card.picture = cardPicture;
	card.chat.picture = chatPicture;
	const data = JSON.stringify(card);

	const row: ScenarioRow = {
		id,
		owner_id: user.id,
		parent_id: forked ? existing!.id : (existing?.parent_id ?? null),
		authors: JSON.stringify(authors),
		title: card.card.title,
		snippet: card["kawa-snippet"]!.summary,
		tags: JSON.stringify(card.card.tags),
		character_name: card.chat.name,
		token_count: card.chat.tokenCount,
		card_picture: cardPicture,
		chat_picture: chatPicture,
		data,
		score: forked || !existing ? 0 : existing.score,
		comment_count: forked || !existing ? 0 : existing.comment_count,
		published_at: forked || !existing ? now : existing.published_at,
		updated_at: now,
		delisted_at: null
	};

	await db.transaction().execute(async trx => {
		if (existing && !forked) {
			const { id: _, score: _s, comment_count: _c, ...update } = row;
			await trx.updateTable("scenarios").set(update).where("id", "=", id).execute();
		} else {
			await trx.insertInto("scenarios").values(row).execute();
		}
		await indexScenario(trx, row);
	});
	invalidateHome();

	const users = await authorsFor([row]);
	const result: PublishResult = { id, forked, card: await toCard(row, users) };
	return c.json(result);
});

scenarioRoutes.post("/:id/delist", async c => {
	const user = requireUser(c);
	const row = ensure(await getRow(c.req.param("id")), 404, "scenario not found");
	if (row.owner_id !== user.id && !user.is_admin) fail(403, "not your scenario");
	await db.transaction().execute(async trx => {
		await trx.updateTable("scenarios").set({ delisted_at: Date.now() }).where("id", "=", row.id).execute();
		await unindexScenario(trx, row.id);
	});
	invalidateHome();
	return c.json({ ok: true });
});

scenarioRoutes.post("/:id/vote", async c => {
	const user = requireUser(c);
	const id = c.req.param("id");
	const value = clampVote((await readJSON(c))?.value);
	const row = ensure(await getRow(id), 404, "scenario not found");
	if (row.delisted_at) fail(410, "scenario is delisted");

	const score = await db.transaction().execute(async trx => {
		if (value === 0) {
			await trx.deleteFrom("scenario_votes").where("user_id", "=", user.id).where("scenario_id", "=", id).execute();
		} else {
			await trx
				.insertInto("scenario_votes")
				.values({ user_id: user.id, scenario_id: id, value })
				.onConflict(oc => oc.columns(["user_id", "scenario_id"]).doUpdateSet({ value }))
				.execute();
		}
		const { total } = await trx
			.selectFrom("scenario_votes")
			.select(sql<number>`coalesce(sum(value), 0)`.as("total"))
			.where("scenario_id", "=", id)
			.executeTakeFirstOrThrow();
		await trx.updateTable("scenarios").set({ score: total }).where("id", "=", id).execute();
		return total;
	});
	invalidateHome();
	return c.json({ score, myVote: value });
});
