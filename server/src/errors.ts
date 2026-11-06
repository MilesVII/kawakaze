import { Hono } from "hono";
import { sql } from "kysely";
import type { AdminErrorReport } from "@shared/api";
import { PER_PAGE } from "@shared/api";
import type { AppEnv } from "./auth";
import { db } from "./db";
import { rateLimiter } from "./ratelimit";
import { usersById } from "./users";
import { clientIP, fail, hashIP, isString, makePage, readJSON, sha256 } from "./util";

/*
Client error reports: kirov.ts sends uncaught errors and rejections here, admins read them in the admin panel.
Anyone can report, signed in or not, so everything is trimmed and rate limited. The same error (message and stack)
stays one row with a counter and the latest page, user and browser; only the most recently seen MAX_REPORTS are kept.
*/

const MAX_REPORTS = 500;
const MESSAGE_CHARS = 1000;
const STACK_CHARS = 8000;
const URL_CHARS = 300;
const USER_AGENT_CHARS = 300;

const reportLimit = rateLimiter(30, 10 * 60_000);

export const errorRoutes = new Hono<AppEnv>();

errorRoutes.post("/", async c => {
	const user = c.get("user");
	const ipHash = hashIP(clientIP(c));
	if (!reportLimit(user?.id ?? ipHash ?? "unknown")) fail(429, "slow down");

	const body = await readJSON(c);
	const message = isString(body?.message) ? body.message.trim().slice(0, MESSAGE_CHARS) : "";
	if (!message) fail(400, "message is empty");
	const stack = isString(body?.stack) ? body.stack.trim().slice(0, STACK_CHARS) : "";
	const url = isString(body?.url) && body.url.startsWith("/") ? body.url.slice(0, URL_CHARS) : "";
	const userAgent = (c.req.header("user-agent") ?? "").slice(0, USER_AGENT_CHARS);

	const now = Date.now();
	const latest = { url, user_agent: userAgent, user_id: user?.id ?? null, ip_hash: ipHash, last_at: now };
	await db
		.insertInto("error_reports")
		.values({ ...latest, fingerprint: sha256(`${message}\n${stack}`), message, stack, count: 1, first_at: now })
		.onConflict(oc => oc.column("fingerprint").doUpdateSet({ ...latest, count: sql<number>`error_reports.count + 1` }))
		.execute();
	await db
		.deleteFrom("error_reports")
		.where("id", "in", db.selectFrom("error_reports").select("id").orderBy("last_at", "desc").limit(-1).offset(MAX_REPORTS))
		.execute();
	return c.json({ ok: true });
});

/** for the admin panel: most recently seen first */
export async function listErrorReports(page: number) {
	const [{ total }, rows] = await Promise.all([
		db.selectFrom("error_reports").select(sql<number>`count(*)`.as("total")).executeTakeFirstOrThrow(),
		db.selectFrom("error_reports").selectAll().orderBy("last_at", "desc").limit(PER_PAGE).offset(page * PER_PAGE).execute()
	]);
	const users = await usersById(rows.map(r => r.user_id).filter(id => id) as string[]);
	const items: AdminErrorReport[] = rows.map(r => ({
		id: r.id,
		message: r.message,
		stack: r.stack,
		url: r.url,
		userAgent: r.user_agent,
		user: r.user_id ? users.get(r.user_id) ?? null : null,
		ipHash: r.ip_hash,
		count: r.count,
		firstAt: r.first_at,
		lastAt: r.last_at
	}));
	return makePage(items, page, total);
}
