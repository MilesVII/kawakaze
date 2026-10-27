import fs from "node:fs/promises";
import { Hono } from "hono";
import { sql } from "kysely";
import type { AdminComment, AdminUser, DiskReport, Invite } from "@shared/api";
import { PER_PAGE } from "@shared/api";
import { requireAdmin, type AppEnv } from "../auth";
import { config } from "../config";
import { db } from "../db";
import { purgeContent } from "../purge";
import { userRef, usersById } from "../users";
import { ensure, fail, isString, makePage, pageParam, randomToken, readJSON } from "../util";
import { commentsQuery, toComments } from "./comments";

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use(async (c, next) => {
	requireAdmin(c);
	await next();
});

async function fileSize(path: string) {
	try {
		return (await fs.stat(path)).size;
	} catch {
		return 0;
	}
}

async function count(table: "users" | "scenarios" | "comments" | "sync", creatorsOnly = false) {
	let q = db.selectFrom(table).select(sql<number>`count(*)`.as("n"));
	if (creatorsOnly) q = (q as any).where("is_creator", "=", 1);
	return (await q.executeTakeFirstOrThrow()).n;
}

adminRoutes.get("/disk", async c => {
	const media = await db
		.selectFrom("media")
		.select([sql<number>`coalesce(sum(bytes), 0)`.as("bytes"), sql<number>`count(*)`.as("files")])
		.executeTakeFirstOrThrow();
	const sync = await db
		.selectFrom("sync")
		.select([sql<number>`coalesce(sum(bytes), 0)`.as("bytes"), sql<number>`count(*)`.as("items")])
		.executeTakeFirstOrThrow();
	const fsStats = await fs.statfs(config.dataDir);
	const dbBytes = (await fileSize(config.dbPath)) + (await fileSize(`${config.dbPath}-wal`));

	const report: DiskReport = {
		dbBytes,
		mediaBytes: media.bytes,
		mediaFiles: media.files,
		syncBytes: sync.bytes,
		syncItems: sync.items,
		freeBytes: fsStats.bavail * fsStats.bsize,
		totalBytes: fsStats.blocks * fsStats.bsize,
		users: await count("users"),
		creators: await count("users", true),
		scenarios: await count("scenarios"),
		comments: await count("comments")
	};
	return c.json(report);
});

// ---- invites ----

async function listInvites(tokens?: string[]): Promise<Invite[]> {
	let q = db.selectFrom("invites").selectAll().orderBy("created_at", "desc");
	if (tokens) q = q.where("token", "in", tokens.length ? tokens : [""]);
	const rows = await q.limit(500).execute();
	const users = await usersById(rows.map(r => r.used_by).filter(id => id) as string[]);
	return rows.map(r => ({
		token: r.token,
		note: r.note,
		createdAt: r.created_at,
		usedBy: r.used_by ? users.get(r.used_by) ?? null : null,
		usedAt: r.used_at
	}));
}

export async function issueInvites(count: number, note: string, createdBy: string | null) {
	const now = Date.now();
	const tokens = Array.from({ length: count }, () => `kawa-${randomToken(12)}`);
	await db
		.insertInto("invites")
		.values(tokens.map(token => ({ token, note, created_at: now, created_by: createdBy, used_by: null, used_at: null })))
		.execute();
	return tokens;
}

adminRoutes.get("/invites", async c => c.json(await listInvites()));

adminRoutes.post("/invites", async c => {
	const admin = requireAdmin(c);
	const body = await readJSON(c);
	const n = Number(body?.count ?? 1);
	if (!Number.isInteger(n) || n < 1 || n > 100) fail(400, "count must be 1-100");
	const note = isString(body?.note) ? body.note.slice(0, 200) : "";
	const tokens = await issueInvites(n, note, admin.id);
	return c.json(await listInvites(tokens));
});

adminRoutes.delete("/invites/:token", async c => {
	const result = await db.deleteFrom("invites").where("token", "=", c.req.param("token")).executeTakeFirst();
	ensure(Number(result.numDeletedRows) > 0, 404, "invite not found");
	return c.json({ ok: true });
});

// ---- users ----

function usersQuery() {
	return db
		.selectFrom("users")
		.selectAll("users")
		.select([
			sql<number>`(select count(*) from scenarios where owner_id = users.id)`.as("scenario_count"),
			sql<number>`(select count(*) from comments where user_id = users.id)`.as("comment_count"),
			sql<number>`(select coalesce(sum(bytes), 0) from media where owner_id = users.id)`.as("media_bytes"),
			sql<number>`(select coalesce(sum(bytes), 0) from sync where user_id = users.id)`.as("sync_bytes"),
			sql<string>`(select coalesce(group_concat(provider), '') from identities where user_id = users.id)`.as("providers")
		]);
}
type AdminUserRow = Awaited<ReturnType<ReturnType<typeof usersQuery>["executeTakeFirstOrThrow"]>>;

function toAdminUser(r: AdminUserRow): AdminUser {
	return {
		...userRef(r),
		createdAt: r.created_at,
		lastSeenAt: r.last_seen_at,
		providers: r.providers ? r.providers.split(",") : [],
		isCreator: Boolean(r.is_creator),
		isAdmin: Boolean(r.is_admin),
		banned: r.banned_at !== null,
		scenarioCount: r.scenario_count,
		commentCount: r.comment_count,
		mediaBytes: r.media_bytes,
		syncBytes: r.sync_bytes
	};
}

async function adminUser(id: string) {
	return toAdminUser(ensure(await usersQuery().where("users.id", "=", id).executeTakeFirst(), 404, "user not found"));
}

adminRoutes.get("/users", async c => {
	const page = pageParam(c);
	const q = (c.req.query("q") ?? "").trim();
	let base = usersQuery();
	let counter = db.selectFrom("users").select(sql<number>`count(*)`.as("total"));
	if (q) {
		const like = `%${q.replace(/[%_\\]/g, m => `\\${m}`)}%`;
		base = base.where(sql<boolean>`users.username like ${like} escape '\\'`);
		counter = counter.where(sql<boolean>`users.username like ${like} escape '\\'`);
	}
	const [{ total }, rows] = await Promise.all([
		counter.executeTakeFirstOrThrow(),
		base
			.orderBy(sql`media_bytes + sync_bytes`, "desc")
			.orderBy("users.created_at", "desc")
			.limit(PER_PAGE)
			.offset(page * PER_PAGE)
			.execute()
	]);
	return c.json(makePage(rows.map(toAdminUser), page, total));
});

adminRoutes.post("/users/:id/ban", async c => {
	const admin = requireAdmin(c);
	const id = c.req.param("id");
	if (id === admin.id) fail(400, "you can't ban yourself");
	const banned = (await readJSON(c))?.banned === true;
	await db.updateTable("users").set({ banned_at: banned ? Date.now() : null }).where("id", "=", id).execute();
	if (banned) await db.deleteFrom("sessions").where("user_id", "=", id).execute();
	return c.json(await adminUser(id));
});

adminRoutes.post("/users/:id/creator", async c => {
	const id = c.req.param("id");
	const creator = (await readJSON(c))?.creator === true;
	await db.updateTable("users").set({ is_creator: creator ? 1 : 0 }).where("id", "=", id).execute();
	return c.json(await adminUser(id));
});

adminRoutes.post("/users/:id/purge", async c => {
	const id = c.req.param("id");
	await adminUser(id);
	return c.json(await purgeContent(id));
});

// ---- comments ----

adminRoutes.get("/comments", async c => {
	const page = pageParam(c);
	const [{ total }, rows] = await Promise.all([
		db.selectFrom("comments").select(sql<number>`count(*)`.as("total")).executeTakeFirstOrThrow(),
		commentsQuery()
			.select(["scenarios.title as scenario_title", "comments.ip_hash"])
			.orderBy("comments.created_at", "desc")
			.limit(PER_PAGE)
			.offset(page * PER_PAGE)
			.execute()
	]);
	const comments = await toComments(rows, c.get("user"));
	const items: AdminComment[] = comments.map((comment, i) => ({
		...comment,
		scenarioTitle: rows[i].scenario_title,
		ipHash: rows[i].ip_hash
	}));
	return c.json(makePage(items, page, total));
});
