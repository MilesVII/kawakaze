import { Hono } from "hono";
import { sql } from "kysely";
import type { Comment } from "@shared/api";
import { LIMITS, MENTION_RE, PER_PAGE } from "@shared/api";
import { requireUser, type AppEnv } from "../auth";
import { invalidateHome } from "../catalog";
import { config } from "../config";
import { db } from "../db";
import type { User } from "../db/schema";
import { rateLimiter } from "../ratelimit";
import { usersById } from "../users";
import { HttpError, clampVote, clientIP, ensure, fail, hashIP, isString, makePage, pageParam, readJSON } from "../util";

export const commentRoutes = new Hono<AppEnv>();

const anonLimit = rateLimiter(5, 10 * 60 * 1000);
const userLimit = rateLimiter(30, 10 * 60 * 1000);

export type CommentRow = {
	id: number,
	scenario_id: string,
	user_id: string | null,
	body: string,
	score: number,
	created_at: number,
	owner_id: string
};

/** Rows (joined with scenarios.owner_id) -> API comments from the viewer's point of view */
export async function toComments(rows: CommentRow[], viewer: User | null): Promise<Comment[]> {
	const users = await usersById(rows.map(r => r.user_id).filter(id => id) as string[]);
	const votes = new Map<number, number>();
	if (viewer && rows.length > 0) {
		const vs = await db
			.selectFrom("comment_votes")
			.select(["comment_id", "value"])
			.where("user_id", "=", viewer.id)
			.where("comment_id", "in", rows.map(r => r.id))
			.execute();
		for (const v of vs) votes.set(v.comment_id, v.value);
	}
	return rows.map(r => ({
		id: r.id,
		scenarioId: r.scenario_id,
		author: r.user_id ? users.get(r.user_id) ?? null : null,
		body: r.body,
		createdAt: r.created_at,
		score: r.score,
		myVote: clampVote(votes.get(r.id)),
		canDelete: Boolean(viewer && (viewer.is_admin || viewer.id === r.user_id || viewer.id === r.owner_id))
	}));
}

export function commentsQuery() {
	return db
		.selectFrom("comments")
		.innerJoin("scenarios", "scenarios.id", "comments.scenario_id")
		.select([
			"comments.id",
			"comments.scenario_id",
			"comments.user_id",
			"comments.body",
			"comments.score",
			"comments.created_at",
			"scenarios.owner_id"
		]);
}

async function refreshCommentCount(scenarioId: string) {
	await db
		.updateTable("scenarios")
		.set({ comment_count: sql<number>`(select count(*) from comments where scenario_id = ${scenarioId})` })
		.where("id", "=", scenarioId)
		.execute();
	invalidateHome();
}

async function verifyTurnstile(token: unknown, ip: string | null) {
	if (!config.turnstile.secret || !config.turnstile.siteKey) fail(403, "anonymous comments are disabled, please sign in");
	if (!isString(token) || !token) fail(400, "captcha is required");
	const body = new URLSearchParams({ secret: config.turnstile.secret, response: token });
	if (ip) body.set("remoteip", ip);
	try {
		const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
		const result = await response.json() as { success?: boolean };
		if (!result.success) fail(403, "captcha check failed");
	} catch (e) {
		if (e instanceof HttpError) throw e;
		fail(502, "captcha service unavailable");
	}
}

commentRoutes.get("/scenarios/:id/comments", async c => {
	const id = c.req.param("id");
	const page = pageParam(c);
	const [{ total }, rows] = await Promise.all([
		db.selectFrom("comments").select(sql<number>`count(*)`.as("total")).where("scenario_id", "=", id).executeTakeFirstOrThrow(),
		commentsQuery()
			.where("comments.scenario_id", "=", id)
			.orderBy("comments.created_at", "desc")
			.limit(PER_PAGE)
			.offset(page * PER_PAGE)
			.execute()
	]);
	return c.json(makePage(await toComments(rows, c.get("user")), page, total));
});

commentRoutes.post("/scenarios/:id/comments", async c => {
	const user = c.get("user");
	const scenario = ensure(
		await db.selectFrom("scenarios").select(["id", "owner_id", "delisted_at"]).where("id", "=", c.req.param("id")).executeTakeFirst(),
		404, "scenario not found"
	);
	if (scenario.delisted_at) fail(410, "scenario is delisted");

	const payload = await readJSON(c);
	const body: string = isString(payload?.body) ? payload.body.trim() : "";
	if (!body) fail(400, "comment is empty");
	if (body.length > LIMITS.comment) fail(400, `comments are limited to ${LIMITS.comment} characters`);

	const ip = clientIP(c);
	const ipHash = hashIP(ip);
	if (user) {
		if (!userLimit(user.id)) fail(429, "slow down");
	} else {
		if (!anonLimit(ipHash ?? "unknown")) fail(429, "slow down");
		await verifyTurnstile(payload?.turnstile, ip);
	}

	const now = Date.now();
	const inserted = await db
		.insertInto("comments")
		.values({ scenario_id: scenario.id, user_id: user?.id ?? null, body, ip_hash: ipHash, created_at: now })
		.returning("id")
		.executeTakeFirstOrThrow();

	// notifications: mentioned users, then the scenario owner unless already mentioned
	const mentioned = Array.from(new Set(Array.from(body.matchAll(MENTION_RE), m => m[2].toLowerCase()))).slice(0, 10);
	const recipients = new Map<string, "mention" | "comment">();
	if (mentioned.length > 0) {
		const users = await db
			.selectFrom("users")
			.select("id")
			.where(sql<boolean>`lower(username) in (${sql.join(mentioned)})`)
			.execute();
		for (const u of users) recipients.set(u.id, "mention");
	}
	if (!recipients.has(scenario.owner_id)) recipients.set(scenario.owner_id, "comment");
	if (user) recipients.delete(user.id);
	if (recipients.size > 0) {
		await db
			.insertInto("notifications")
			.values(Array.from(recipients, ([userId, kind]) => ({
				user_id: userId,
				kind,
				actor_id: user?.id ?? null,
				scenario_id: scenario.id,
				comment_id: inserted.id,
				created_at: now,
				read_at: null
			})))
			.execute();
	}

	await refreshCommentCount(scenario.id);
	const row = await commentsQuery().where("comments.id", "=", inserted.id).executeTakeFirstOrThrow();
	const [comment] = await toComments([row], user);
	return c.json(comment);
});

commentRoutes.delete("/comments/:id", async c => {
	const user = requireUser(c);
	const id = parseInt(c.req.param("id"), 10);
	const row = ensure(await commentsQuery().where("comments.id", "=", id).executeTakeFirst(), 404, "comment not found");
	if (!user.is_admin && user.id !== row.user_id && user.id !== row.owner_id) fail(403, "can't delete this comment");
	await db.deleteFrom("comments").where("id", "=", id).execute();
	await refreshCommentCount(row.scenario_id);
	return c.json({ ok: true });
});

commentRoutes.post("/comments/:id/vote", async c => {
	const user = requireUser(c);
	const id = parseInt(c.req.param("id"), 10);
	const value = clampVote((await readJSON(c))?.value);
	ensure(await db.selectFrom("comments").select("id").where("id", "=", id).executeTakeFirst(), 404, "comment not found");

	const score = await db.transaction().execute(async trx => {
		if (value === 0) {
			await trx.deleteFrom("comment_votes").where("user_id", "=", user.id).where("comment_id", "=", id).execute();
		} else {
			await trx
				.insertInto("comment_votes")
				.values({ user_id: user.id, comment_id: id, value })
				.onConflict(oc => oc.columns(["user_id", "comment_id"]).doUpdateSet({ value }))
				.execute();
		}
		const { total } = await trx
			.selectFrom("comment_votes")
			.select(sql<number>`coalesce(sum(value), 0)`.as("total"))
			.where("comment_id", "=", id)
			.executeTakeFirstOrThrow();
		await trx.updateTable("comments").set({ score: total }).where("id", "=", id).execute();
		return total;
	});
	return c.json({ score, myVote: value });
});
