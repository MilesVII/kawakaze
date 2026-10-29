import { idb, isRemoteRef } from "./persist";
import { b64Encoder, nothrowAsync } from "./utils";
import type { MediaEntry } from "./types";

/*
Turning picture refs into portable media entries for exports, backups and sync.
Local refs are read from IndexedDB. Remote refs (server media URLs) are fetched and kept under the URL as
their id, so Ägir finds them by the same ref without rewriting anything.
*/

export type EncodedMedia = { id: string, mime: string, media: string };

export async function encodeMedia(refs: (string | null | undefined)[], includeRemote: boolean): Promise<EncodedMedia[]> {
	const ids = Array.from(new Set(refs.filter(r => r) as string[]));
	const encoded = await Promise.all(ids.map(async id => {
		if (isRemoteRef(id)) {
			if (!includeRemote) return null;
			const blob = await fetchBlob(id);
			if (!blob) return null;
			return { id, mime: blob.type || "image/webp", media: await b64Encoder.encode(blob) };
		}
		const entry = await idb.get("media", id);
		if (!entry.success || !entry.value) return null;
		return { id, mime: entry.value.mime, media: await b64Encoder.encode(entry.value.media) };
	}));
	return encoded.filter(e => e) as EncodedMedia[];
}

/** base64 of a single ref, the way Ägir scenario exports embed pictures */
export async function encodeRef(ref: string | null): Promise<string | null> {
	if (!ref) return null;
	const [entry] = await encodeMedia([ref], true);
	return entry?.media ?? null;
}

export async function refToBlob(ref: string): Promise<Blob | null> {
	if (isRemoteRef(ref)) return fetchBlob(ref);
	const entry = await idb.get("media", ref);
	if (!entry.success || !entry.value) return null;
	return entry.value.media;
}

async function fetchBlob(url: string) {
	const response = await nothrowAsync(fetch(url));
	if (!response.success || !response.value.ok) return null;
	const blob = await nothrowAsync(response.value.blob());
	return blob.success ? blob.value : null;
}

/** stores decoded entries locally; entries keyed by server URLs are skipped since those resolve remotely */
export async function storeMedia(entries: EncodedMedia[]) {
	const decoded: MediaEntry[] = [];
	for (const m of entries) {
		if (isRemoteRef(m.id)) continue;
		decoded.push({ id: m.id, mime: m.mime, media: await b64Encoder.decode(m.media) });
	}
	return await idb.setMany("media", decoded);
}
