import { Hono } from "hono";
import { sql } from "kysely";
import type { CommentWithScenario, Notification, SessionInfo } from "@shared/api";
import { LIMITS, PER_PAGE, USERNAME_RE } from "@shared/api";
import { requireUser, signOut, type AppEnv } from "../auth";
import { authorsFor, invalidateHome, reindexAuthor, toMeta } from "../catalog";
import { db } from "../db";
import { storePicture } from "../media";
import { deleteAccount } from "../purge";
import { findUserByName, toMe, usersById } from "../users";
import { clampVote, ensure, fail, isString, isStringArray, makePage, pageParam, readJSON } from "../util";
import { commentsQuery, toComments } from "./comments";

export const meRoutes = new Hono<AppEnv>();

async function freshUser(id: string) {
	return await db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

meRoutes.get("/", async c => {
	const user = c.get("user");
	return c.json(user ? await toMe(user) : null);
});

meRoutes.patch("/", async c => {
	const user = requireUser(c);
	const body = await readJSON(c);
	const update: { username?: string, bio?: string, hidden_tags?: string } = {};

	if (body?.username !== undefined) {
		const username = isString(body.username) ? body.username.trim() : "";
		if (!USERNAME_RE.test(username)) fail(400, "username must be 3-24 characters: letters, digits, _ and -");
		const taken = await findUserByName(username);
		if (taken && taken.id !== user.id) fail(409, "username is taken");
		update.username = username;
	}
	if (body?.bio !== undefined) {
		if (!isString(body.bio)) fail(400, "bio must be a string");
		if (body.bio.length > LIMITS.bio) fail(400, `bio is limited to ${LIMITS.bio} characters`);
		update.bio = body.bio;
	}
	if (body?.hiddenTags !== undefined) {
		const hidden: unknown = body.hiddenTags;
		if (!isStringArray(hidden)) fail(400, "hiddenTags must be a list of strings");
		const tags = Array.from(new Set(hidden.map(t => t.trim()).filter(t => t)));
		if (tags.length > LIMITS.hiddenTags) fail(400, `at most ${LIMITS.hiddenTags} hidden tags`);
		if (tags.some(t => t.length > LIMITS.tagLength)) fail(400, "tag is too long");
		update.hidden_tags = JSON.stringify(tags);
	}

	if (Object.keys(update).length > 0)
		await db.updateTable("users").set(update).where("id", "=", user.id).execute();
	if (update.username && update.username !== user.username) await reindexAuthor(user.id);

	return c.json(await toMe(await freshUser(user.id)));
});

meRoutes.put("/icon", async c => {
	const user = requireUser(c);
	const body = await c.req.parseBody();
	const file = body.icon instanceof File ? body.icon : fail(400, "icon file is required");
	const hash = await storePicture(file, user.id);
	await db.updateTable("users").set({ icon: hash }).where("id", "=", user.id).execute();
	invalidateHome();
	return c.json(await toMe(await freshUser(user.id)));
});

meRoutes.delete("/icon", async c => {
	const user = requireUser(c);
	await db.updateTable("users").set({ icon: null }).where("id", "=", user.id).execute();
	invalidateHome();
	return c.json(await toMe(await freshUser(user.id)));
});

meRoutes.delete("/", async c => {
	const user = requireUser(c);
	const body = await readJSON(c);
	if (!isString(body?.confirm) || body.confirm.toLowerCase() !== user.username.toLowerCase())
		fail(400, "type your username to confirm");
	await signOut(c);
	await deleteAccount(user.id);
	return c.json({ ok: true });
});

meRoutes.post("/redeem", async c => {
	const user = requireUser(c);
	const body = await readJSON(c);
	if (body?.acceptTerms !== true) fail(400, "you have to accept the terms of use");
	const token = isString(body?.token) ? body.token.trim() : "";
	if (!token) fail(400, "invite token is required");
	if (user.is_creator) fail(409, "you are a creator already");

	const now = Date.now();
	const used = await db.transaction().execute(async trx => {
		const result = await trx
			.updateTable("invites")
			.set({ used_by: user.id, used_at: now })
			.where("token", "=", token)
			.where("used_by", "is", null)
			.where("used_at", "is", null)
			.executeTakeFirst();
		if (Number(result.numUpdatedRows) !== 1) return false;
		await trx.updateTable("users").set({ is_creator: 1, terms_accepted_at: now }).where("id", "=", user.id).execute();
		return true;
	});
	if (!used) fail(400, "invite token is invalid or already used");
	return c.json(await toMe(await freshUser(user.id)));
});

meRoutes.get("/comments", async c => {
	const user = requireUser(c);
	const page = pageParam(c);
	const [{ total }, rows] = await Promise.all([
		db.selectFrom("comments").select(sql<number>`count(*)`.as("total")).where("user_id", "=", user.id).executeTakeFirstOrThrow(),
		commentsQuery()
			.select("scenarios.title as scenario_title")
			.where("comments.user_id", "=", user.id)
			.orderBy("comments.created_at", "desc")
			.limit(PER_PAGE)
			.offset(page * PER_PAGE)
			.execute()
	]);
	const comments = await toComments(rows, user);
	const items: CommentWithScenario[] = comments.map((comment, i) => ({ ...comment, scenarioTitle: rows[i].scenario_title }));
	return c.json(makePage(items, page, total));
});

meRoutes.get("/scenarios", async c => {
	const user = requireUser(c);
	const rows = await db
		.selectFrom("scenarios")
		.selectAll()
		.where("owner_id", "=", user.id)
		.orderBy("updated_at", "desc")
		.execute();
	const users = await authorsFor(rows);
	const votes = new Map<string, number>();
	if (rows.length > 0) {
		const vs = await db
			.selectFrom("scenario_votes")
			.select(["scenario_id", "value"])
			.where("user_id", "=", user.id)
			.where("scenario_id", "in", rows.map(r => r.id))
			.execute();
		for (const v of vs) votes.set(v.scenario_id, v.value);
	}
	return c.json(rows.map(r => toMeta(r, users, clampVote(votes.get(r.id)))));
});

meRoutes.get("/notifications", async c => {
	const user = requireUser(c);
	const page = pageParam(c);
	const [{ total }, rows] = await Promise.all([
		db.selectFrom("notifications").select(sql<number>`count(*)`.as("total")).where("user_id", "=", user.id).executeTakeFirstOrThrow(),
		db
			.selectFrom("notifications")
			.innerJoin("scenarios", "scenarios.id", "notifications.scenario_id")
			.innerJoin("comments", "comments.id", "notifications.comment_id")
			.select([
				"notifications.id",
				"notifications.kind",
				"notifications.created_at",
				"notifications.read_at",
				"notifications.actor_id",
				"scenarios.id as scenario_id",
				"scenarios.title as scenario_title",
				"comments.id as comment_id",
				"comments.body as comment_body"
			])
			.where("notifications.user_id", "=", user.id)
			.orderBy("notifications.created_at", "desc")
			.limit(PER_PAGE)
			.offset(page * PER_PAGE)
			.execute()
	]);
	const actors = await usersById(rows.map(r => r.actor_id).filter(id => id) as string[]);
	const items: Notification[] = rows.map(r => ({
		id: r.id,
		kind: r.kind,
		createdAt: r.created_at,
		read: r.read_at !== null,
		actor: r.actor_id ? actors.get(r.actor_id) ?? null : null,
		scenario: { id: r.scenario_id, title: r.scenario_title },
		comment: { id: r.comment_id, body: r.comment_body }
	}));
	return c.json(makePage(items, page, total));
});

meRoutes.post("/notifications/read", async c => {
	const user = requireUser(c);
	const body = await readJSON(c).catch(() => ({}));
	let query = db
		.updateTable("notifications")
		.set({ read_at: Date.now() })
		.where("user_id", "=", user.id)
		.where("read_at", "is", null);
	if (Array.isArray(body?.ids)) {
		const ids = body.ids.filter((id: unknown) => Number.isInteger(id)) as number[];
		if (ids.length === 0) return c.json({ ok: true });
		query = query.where("id", "in", ids);
	}
	await query.execute();
	return c.json({ ok: true });
});

meRoutes.get("/sessions", async c => {
	const user = requireUser(c);
	const current = c.get("sessionId");
	const rows = await db
		.selectFrom("sessions")
		.selectAll()
		.where("user_id", "=", user.id)
		.orderBy("last_seen_at", "desc")
		.execute();
	const items: SessionInfo[] = rows.map(r => ({
		id: r.id,
		current: r.id === current,
		createdAt: r.created_at,
		lastSeenAt: r.last_seen_at,
		userAgent: r.user_agent
	}));
	return c.json(items);
});

meRoutes.delete("/sessions/:id", async c => {
	const user = requireUser(c);
	const id = c.req.param("id");
	if (id === c.get("sessionId")) {
		await signOut(c);
	} else {
		ensure(
			Number((await db.deleteFrom("sessions").where("id", "=", id).where("user_id", "=", user.id).executeTakeFirst()).numDeletedRows) > 0,
			404, "session not found"
		);
	}
	return c.json({ ok: true });
});

