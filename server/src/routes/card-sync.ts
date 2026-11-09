import { promisify } from "node:util";
import zlib from "node:zlib";
import { Hono } from "hono";
import type { CardSyncHandle } from "@shared/api";
import { requireUser, type AppEnv } from "../auth";
import { config } from "../config";
import { db } from "../db";
import type { CardSyncTable } from "../db/schema";
import { syncBytesUsed } from "../sync-quota";
import { ID_RE, ensure, fail, isString } from "../util";

/*
Library cards moved between devices, like chat sync (sync.ts). The payload is the card exactly as the library exports it,
pictures base64 inside, so the client imports it the same way as a file.
*/

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const cardSyncRoutes = new Hono<AppEnv>();

type HandleRow = Omit<CardSyncTable, "payload" | "user_id">;
const HANDLE_COLUMNS = ["card_id", "bytes", "title", "character_name", "last_update", "uploaded_at"] as const;

function toHandle(r: HandleRow): CardSyncHandle {
	return {
		id: r.card_id,
		title: r.title,
		characterName: r.character_name,
		lastUpdate: r.last_update,
		uploadedAt: r.uploaded_at,
		bytes: r.bytes
	};
}

cardSyncRoutes.get("/", async c => {
	const user = requireUser(c);
	const rows = await db
		.selectFrom("card_sync")
		.select(HANDLE_COLUMNS)
		.where("user_id", "=", user.id)
		.orderBy("last_update", "desc")
		.execute();
	return c.json(rows.map(toHandle));
});

cardSyncRoutes.put("/:id", async c => {
	const user = requireUser(c);
	const id = c.req.param("id");
	if (!ID_RE.test(id)) fail(400, "invalid card id");

	const raw = await c.req.text();
	let card: any;
	try {
		card = JSON.parse(raw);
	} catch {
		fail(400, "invalid JSON body");
	}
	if (!card || typeof card !== "object" || card.id !== id) fail(400, "payload must be the card with this id");
	if (!card.card || typeof card.card !== "object" || !card.chat || typeof card.chat !== "object")
		fail(400, "payload must be an exported scenario card");

	const packed = new Uint8Array(await gzip(raw));
	const used = await syncBytesUsed(user.id, { table: "card_sync", id });
	if (used + packed.length > config.quota.syncBytes) fail(413, "sync storage quota exceeded");

	const row = {
		user_id: user.id,
		card_id: id,
		payload: packed,
		bytes: packed.length,
		title: isString(card.card.title) ? card.card.title.slice(0, 200) : "",
		character_name: isString(card.chat.name) ? card.chat.name.slice(0, 200) : "",
		last_update: Number(card.lastUpdate) || Date.now(),
		uploaded_at: Date.now()
	};
	const { user_id: _, ...update } = row;
	await db
		.insertInto("card_sync")
		.values(row)
		.onConflict(oc => oc.columns(["user_id", "card_id"]).doUpdateSet(update))
		.execute();
	return c.json(toHandle(row));
});

cardSyncRoutes.get("/:id", async c => {
	const user = requireUser(c);
	const row = ensure(
		await db
			.selectFrom("card_sync")
			.select("payload")
			.where("user_id", "=", user.id)
			.where("card_id", "=", c.req.param("id"))
			.executeTakeFirst(),
		404, "no such synced card"
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

cardSyncRoutes.delete("/:id", async c => {
	const user = requireUser(c);
	const result = await db
		.deleteFrom("card_sync")
		.where("user_id", "=", user.id)
		.where("card_id", "=", c.req.param("id"))
		.executeTakeFirst();
	ensure(Number(result.numDeletedRows) > 0, 404, "no such synced card");
	return c.json({ ok: true });
});
