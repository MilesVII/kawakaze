import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type OutputInfo } from "sharp";
import { sql, type Kysely } from "kysely";
import { LIMITS, type MediaLibrary, type MediaUse } from "@shared/api";
import { config } from "./config";
import { db } from "./db";
import type { Database } from "./db/schema";
import { HttpError, fail, sha256 } from "./util";

const SMALLER_SIZE_LIMIT = 2048;
const HASH_RE = /^[0-9a-f]{64}$/;

export function mediaUrl(hash: string): string;
export function mediaUrl(hash: string | null): string | null;
export function mediaUrl(hash: string | null) {
	return hash ? `${config.publicUrl}/media/${hash}.webp` : null;
}
export function mediaPath(hash: string) {
	if (!HASH_RE.test(hash)) throw new Error("bad media hash");
	return path.join(config.mediaDir, `${hash}.webp`);
}

/** Server media URL (absolute on this host, or a bare /media/ path) -> hash; anything else -> null */
export function parseMediaUrl(ref: string): string | null {
	let pathname = ref;
	if (/^https?:\/\//i.test(ref)) {
		let url: URL;
		try {
			url = new URL(ref);
		} catch {
			return null;
		}
		if (url.origin !== config.publicOrigin) return null;
		pathname = url.pathname;
	}
	const match = pathname.match(/^\/media\/([0-9a-f]{64})\.webp$/);
	return match ? match[1] : null;
}

export async function mediaExists(hash: string) {
	const row = await db.selectFrom("media").select("hash").where("hash", "=", hash).executeTakeFirst();
	return Boolean(row);
}

/** quota use: every picture among the user's uploads, at full size, whoever else has it too */
export async function userMediaBytes(userId: string) {
	const row = await db
		.selectFrom("media_uploads")
		.innerJoin("media", "media.hash", "media_uploads.hash")
		.select(sql<number>`coalesce(sum(media.bytes), 0)`.as("total"))
		.where("media_uploads.user_id", "=", userId)
		.executeTakeFirstOrThrow();
	return row.total;
}

/**
 * Re-encodes an uploaded picture to webp (smaller side <= 2048, no metadata), stores it by content hash
 * and adds it to the user's uploads (on top if it's there already). A picture already on disk is not stored again,
 * but it counts against the uploader's quota like any of their uploads.
 */
export async function storePicture(file: File, userId: string): Promise<string> {
	if (file.size > LIMITS.pictureBytes) fail(413, "picture is too large");
	const input = new Uint8Array(await file.arrayBuffer());

	let output: Buffer;
	let info: OutputInfo;
	try {
		const image = sharp(input, { failOn: "error", limitInputPixels: 64_000_000, animated: false });
		const meta = await image.metadata();
		if (!meta.width || !meta.height) fail(400, "not an image");
		const smaller = Math.min(meta.width, meta.height);
		const resize = smaller > SMALLER_SIZE_LIMIT
			? { width: Math.round(meta.width * SMALLER_SIZE_LIMIT / smaller), height: Math.round(meta.height * SMALLER_SIZE_LIMIT / smaller) }
			: null;
		let pipeline = image.rotate();
		if (resize) pipeline = pipeline.resize(resize.width, resize.height);
		({ data: output, info } = await pipeline.webp({ quality: 90 }).toBuffer({ resolveWithObject: true }));
	} catch (e) {
		if (e instanceof HttpError) throw e;
		fail(400, "not a supported image");
	}

	const hash = sha256(output);
	const now = Date.now();
	const mine = await db.selectFrom("media_uploads").select("hash").where("user_id", "=", userId).where("hash", "=", hash).executeTakeFirst();
	if (!mine) {
		const used = await userMediaBytes(userId);
		if (used + output.length > config.quota.mediaBytes) fail(413, "media quota exceeded");
	}

	if (!(await mediaExists(hash))) {
		await fs.writeFile(mediaPath(hash), output);
		await db
			.insertInto("media")
			.values({ hash, owner_id: userId, bytes: output.length, width: info.width, height: info.height, created_at: now })
			.onConflict(oc => oc.column("hash").doNothing())
			.execute();
	}
	await db
		.insertInto("media_uploads")
		.values({ user_id: userId, hash, added_at: now })
		.onConflict(oc => oc.columns(["user_id", "hash"]).doUpdateSet({ added_at: now }))
		.execute();
	return hash;
}

/**
 * Forking copies a card's pictures: they join the forker's uploads (without a quota check, the files exist already),
 * so the forker can manage them and the original uploader deleting theirs doesn't break the fork.
 */
export async function copyMediaTo(trx: Kysely<Database>, userId: string, hashes: string[]) {
	if (hashes.length === 0) return;
	const existing = await trx.selectFrom("media").select("hash").where("hash", "in", hashes).execute();
	if (existing.length === 0) return;
	const now = Date.now();
	await trx
		.insertInto("media_uploads")
		.values(existing.map(m => ({ user_id: userId, hash: m.hash, added_at: now })))
		.onConflict(oc => oc.columns(["user_id", "hash"]).doNothing())
		.execute();
}

/** Takes pictures off a user's uploads and deletes the ones nobody else has; returns the number of files deleted */
export async function releaseMedia(userId: string, hashes: string[]) {
	if (hashes.length === 0) return 0;
	await db.deleteFrom("media_uploads").where("user_id", "=", userId).where("hash", "in", hashes).execute();
	return await deleteUnclaimed(hashes);
}

/** Deletes those of `hashes` nobody has among their uploads: rows first, so nothing new links to them, then files */
export async function deleteUnclaimed(hashes: string[]) {
	if (hashes.length === 0) return 0;
	const gone = await db.transaction().execute(async trx => {
		const rows = await trx
			.selectFrom("media")
			.select("hash")
			.where("hash", "in", hashes)
			.where(eb => eb.not(eb.exists(eb.selectFrom("media_uploads").select("hash").whereRef("media_uploads.hash", "=", "media.hash"))))
			.execute();
		const list = rows.map(r => r.hash);
		if (list.length === 0) return [];
		await trx.deleteFrom("media").where("hash", "in", list).execute();
		// a profile picture without a file would show as broken
		await trx.updateTable("users").set({ icon: null }).where("icon", "in", list).execute();
		return list;
	});
	return await deleteMediaFiles(gone);
}

/** The library: the user's uploads, newest first, each with where it's used */
export async function mediaLibrary(userId: string): Promise<MediaLibrary> {
	const rows = await db
		.selectFrom("media_uploads")
		.innerJoin("media", "media.hash", "media_uploads.hash")
		.select(["media.hash", "media.width", "media.height", "media.bytes", "media_uploads.added_at"])
		.where("media_uploads.user_id", "=", userId)
		.orderBy("media_uploads.added_at", "desc")
		.execute();
	const hashes = rows.map(r => r.hash);
	const uses = new Map<string, MediaUse[]>(hashes.map(h => [h, []]));
	const shared = new Set<string>();

	if (hashes.length) {
		const others = await db
			.selectFrom("media_uploads")
			.select("hash")
			.distinct()
			.where("hash", "in", hashes)
			.where("user_id", "!=", userId)
			.execute();
		others.forEach(o => shared.add(o.hash));

		const cards = await db
			.selectFrom("media_refs")
			.innerJoin("scenarios", "scenarios.id", "media_refs.scenario_id")
			.select(["media_refs.hash", "scenarios.id", "scenarios.title", "scenarios.owner_id", "scenarios.delisted_at"])
			.where("media_refs.hash", "in", hashes)
			.orderBy("scenarios.title")
			.execute();
		for (const c of cards) {
			const mine = c.owner_id === userId;
			// someone else's delisted card is nobody's business
			const visible = mine || c.delisted_at === null;
			uses.get(c.hash)!.push({ kind: "card", id: visible ? c.id : null, title: visible ? c.title : "", mine, delisted: c.delisted_at !== null });
		}
		const bios = await db
			.selectFrom("media_refs")
			.innerJoin("users", "users.id", "media_refs.bio_user_id")
			.select(["media_refs.hash", "users.id", "users.username"])
			.where("media_refs.hash", "in", hashes)
			.execute();
		for (const b of bios) uses.get(b.hash)!.push({ kind: "bio", username: b.username, mine: b.id === userId });
		const icons = await db.selectFrom("users").select(["id", "username", "icon"]).where("icon", "in", hashes).execute();
		for (const i of icons) uses.get(i.icon!)!.push({ kind: "icon", username: i.username, mine: i.id === userId });
	}

	return {
		items: rows.map(r => ({
			hash: r.hash,
			url: mediaUrl(r.hash),
			width: r.width,
			height: r.height,
			bytes: r.bytes,
			addedAt: r.added_at,
			shared: shared.has(r.hash),
			uses: uses.get(r.hash)!
		})),
		usedBytes: await userMediaBytes(userId),
		quotaBytes: config.quota.mediaBytes
	};
}

export async function readPictureBase64(hash: string | null) {
	if (!hash) return null;
	try {
		return (await fs.readFile(mediaPath(hash))).toString("base64");
	} catch {
		return null;
	}
}

export async function deleteMediaFiles(hashes: string[]) {
	let deleted = 0;
	for (const hash of hashes) {
		try {
			await fs.unlink(mediaPath(hash));
			deleted++;
		} catch {}
	}
	return deleted;
}
