import { promisify } from "node:util";
import zlib from "node:zlib";
import { Hono } from "hono";
import { sql } from "kysely";
import type { SyncHandle, SyncPayload } from "@shared/api";
import { LIMITS } from "@shared/api";
import { requireUser, type AppEnv } from "../auth";
import { config } from "../config";
import { db } from "../db";
import type { SyncTable } from "../db/schema";
import { parseMediaUrl } from "../media";
import { ID_RE, ensure, fail, isString } from "../util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const syncRoutes = new Hono<AppEnv>();

type HandleRow = Omit<SyncTable, "payload" | "user_id">;
const HANDLE_COLUMNS = ["chat_id", "bytes", "name", "persona_name", "picture", "message_count", "last_update", "uploaded_at"] as const;

function toHandle(r: HandleRow): SyncHandle {
	return {
		id: r.chat_id,
		name: r.name,
		personaName: r.persona_name,
		picture: r.picture,
		messageCount: r.message_count,
		lastUpdate: r.last_update,
		uploadedAt: r.uploaded_at,
		bytes: r.bytes
	};
}

syncRoutes.get("/", async c => {
	const user = requireUser(c);
	const rows = await db
		.selectFrom("sync")
		.select(HANDLE_COLUMNS)
		.where("user_id", "=", user.id)
		.orderBy("last_update", "desc")
		.execute();
	return c.json(rows.map(toHandle));
});

syncRoutes.put("/:id", async c => {
	const user = requireUser(c);
	const id = c.req.param("id");
	if (!ID_RE.test(id)) fail(400, "invalid chat id");

	const raw = await c.req.text();
	let payload: SyncPayload;
	try {
		payload = JSON.parse(raw);
	} catch {
		fail(400, "invalid JSON body");
	}
	const chat = payload?.chat;
	if (!chat || chat.id !== id || !payload.contents || payload.contents.id !== id || !Array.isArray(payload.contents.messages))
		fail(400, "payload must contain the chat and its contents");
	if (!Array.isArray(payload.media)) fail(400, "media must be an array");

	const packed = new Uint8Array(await gzip(raw));
	const { used } = await db
		.selectFrom("sync")
		.select(sql<number>`coalesce(sum(bytes), 0)`.as("used"))
		.where("user_id", "=", user.id)
		.where("chat_id", "!=", id)
		.executeTakeFirstOrThrow();
	if (used + packed.length > config.quota.syncBytes) fail(413, "sync storage quota exceeded");

	const picture = isString(chat.scenario?.picture) && parseMediaUrl(chat.scenario.picture)
		? chat.scenario.picture
		: null;
	const row = {
		user_id: user.id,
		chat_id: id,
		payload: packed,
		bytes: packed.length,
		name: String(chat.scenario?.name ?? "").slice(0, 200),
		persona_name: String(chat.userPersona?.name ?? "").slice(0, 200),
		picture,
		message_count: Number(chat.messageCount) || payload.contents.messages.length,
		last_update: Number(chat.lastUpdate) || Date.now(),
		uploaded_at: Date.now()
	};
	const { user_id: _, payload: __, ...update } = row;
	await db
		.insertInto("sync")
		.values(row)
		.onConflict(oc => oc.columns(["user_id", "chat_id"]).doUpdateSet({ ...update, payload: packed }))
		.execute();
	return c.json(toHandle(row));
});

syncRoutes.get("/:id", async c => {
	const user = requireUser(c);
	const row = ensure(
		await db
			.selectFrom("sync")
			.select("payload")
			.where("user_id", "=", user.id)
			.where("chat_id", "=", c.req.param("id"))
			.executeTakeFirst(),
		404, "no such synced chat"
	);
	const acceptsGzip = /\bgzip\b/.test(c.req.header("accept-encoding") ?? "");
	if (acceptsGzip) {
		return c.body(row.payload as Uint8Array<ArrayBuffer>, 200, {
			"Content-Type": "application/json",
			"Content-Encoding": "gzip",
			"Cache-Control": "no-store"
		});
	}
	const plain = await gunzip(row.payload);
	return c.body(new Uint8Array(plain), 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
});

syncRoutes.delete("/:id", async c => {
	const user = requireUser(c);
	const result = await db
		.deleteFrom("sync")
		.where("user_id", "=", user.id)
		.where("chat_id", "=", c.req.param("id"))
		.executeTakeFirst();
	ensure(Number(result.numDeletedRows) > 0, 404, "no such synced chat");
	return c.json({ ok: true });
});
