import type { Kysely } from "kysely";
import type { Database } from "./db/schema";

/*
Where pictures are used, so the media library can tell unused uploads apart. A stored picture is named by the sha256
of its bytes, so its 64 hex digits found anywhere are a reference: a /media/<hash>.webp link or a bare hash (stored
cards keep their card and chat pictures that way). Whole cards are searched, so descriptions, definitions, openings,
lorebooks and fields added later all count; profile bios count too (they're markdown), current profile pictures are
looked up as they are. Each card and bio keeps its set of hashes in media_refs, replaced whenever it's saved;
hashes are stored whether the file exists or not, so a picture deleted and uploaded again is found again.
`cli media reindex` rebuilds the whole table.
*/

const HASH_RE = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;

export function mediaHashesIn(text: string) {
	return Array.from(new Set(text.match(HASH_RE) ?? []));
}

export async function setScenarioRefs(db: Kysely<Database>, scenarioId: string, data: string) {
	await db.deleteFrom("media_refs").where("scenario_id", "=", scenarioId).execute();
	const hashes = mediaHashesIn(data);
	if (hashes.length) await db.insertInto("media_refs").values(hashes.map(hash => ({ hash, scenario_id: scenarioId, bio_user_id: null }))).execute();
	return hashes;
}

export async function setBioRefs(db: Kysely<Database>, userId: string, bio: string) {
	await db.deleteFrom("media_refs").where("bio_user_id", "=", userId).execute();
	const hashes = mediaHashesIn(bio);
	if (hashes.length) await db.insertInto("media_refs").values(hashes.map(hash => ({ hash, scenario_id: null, bio_user_id: userId }))).execute();
	return hashes;
}

/** Rebuilds media_refs from every card (delisted ones included) and bio */
export async function reindexMediaRefs(db: Kysely<Database>) {
	const atomic = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => db.isTransaction ? fn(db) : db.transaction().execute(fn);
	return await atomic(async trx => {
		await trx.deleteFrom("media_refs").execute();
		let refs = 0;
		const scenarios = await trx.selectFrom("scenarios").select(["id", "data"]).execute();
		for (const s of scenarios) refs += (await setScenarioRefs(trx, s.id, s.data)).length;
		const users = await trx.selectFrom("users").select(["id", "bio"]).where("bio", "!=", "").execute();
		for (const u of users) refs += (await setBioRefs(trx, u.id, u.bio)).length;
		return { scenarios: scenarios.length, bios: users.length, refs };
	});
}
