import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type OutputInfo } from "sharp";
import { sql } from "kysely";
import { LIMITS } from "@shared/api";
import { config } from "./config";
import { db } from "./db";
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

export async function userMediaBytes(userId: string) {
	const row = await db
		.selectFrom("media")
		.select(sql<number>`coalesce(sum(bytes), 0)`.as("total"))
		.where("owner_id", "=", userId)
		.executeTakeFirstOrThrow();
	return row.total;
}

/**
 * Re-encodes an uploaded picture to webp (smaller side <= 2048, no metadata) and stores it by content hash.
 * Deduplicated: a picture already on disk is not stored again and does not count against the quota.
 */
export async function storePicture(file: File, ownerId: string): Promise<string> {
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
	if (await mediaExists(hash)) return hash;

	const used = await userMediaBytes(ownerId);
	if (used + output.length > config.quota.mediaBytes) fail(413, "media quota exceeded");

	await fs.writeFile(mediaPath(hash), output);
	await db
		.insertInto("media")
		.values({
			hash,
			owner_id: ownerId,
			bytes: output.length,
			width: info.width,
			height: info.height,
			created_at: Date.now()
		})
		.onConflict(oc => oc.column("hash").doNothing())
		.execute();
	return hash;
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
