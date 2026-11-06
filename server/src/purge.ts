import { sql } from "kysely";
import type { PurgeResult } from "@shared/api";
import { invalidateHome, unindexScenario } from "./catalog";
import { db } from "./db";
import { deleteUnclaimed } from "./media";

/** Recomputes cached scores and counters touched by deleted votes and comments */
async function recount(scenarioIds: string[], commentIds: number[]) {
	if (scenarioIds.length > 0) {
		await db
			.updateTable("scenarios")
			.set({
				score: sql<number>`coalesce((select sum(value) from scenario_votes where scenario_id = scenarios.id), 0)`,
				comment_count: sql<number>`(select count(*) from comments where scenario_id = scenarios.id)`
			})
			.where("id", "in", scenarioIds)
			.execute();
	}
	if (commentIds.length > 0) {
		await db
			.updateTable("comments")
			.set({ score: sql<number>`coalesce((select sum(value) from comment_votes where comment_id = comments.id), 0)` })
			.where("id", "in", commentIds)
			.execute();
	}
}

/**
Admin purge: scenarios, comments and uploaded media of a user. Votes and the account itself stay.
Pictures they uploaded first go even when others have them (forks copy pictures); ones they got from others are only released.
*/
export async function purgeContent(userId: string): Promise<PurgeResult> {
	const scenarios = await db.selectFrom("scenarios").select("id").where("owner_id", "=", userId).execute();
	const commented = await db.selectFrom("comments").select("scenario_id").where("user_id", "=", userId).execute();
	const uploads = await db.selectFrom("media_uploads").select("hash").where("user_id", "=", userId).execute();
	const original = await db.selectFrom("media").select("hash").where("owner_id", "=", userId).execute();
	const media = Array.from(new Set([...uploads, ...original].map(m => m.hash)));

	const { numDeletedRows: comments } = await db.transaction().execute(async trx => {
		for (const s of scenarios) await unindexScenario(trx, s.id);
		await trx.deleteFrom("scenarios").where("owner_id", "=", userId).execute();
		const result = await trx.deleteFrom("comments").where("user_id", "=", userId).executeTakeFirst();
		await trx.deleteFrom("media_uploads").where("user_id", "=", userId).execute();
		if (original.length) await trx.deleteFrom("media_uploads").where("hash", "in", original.map(m => m.hash)).execute();
		await trx.deleteFrom("media_refs").where("bio_user_id", "=", userId).execute();
		await trx.updateTable("users").set({ icon: null, bio: "" }).where("id", "=", userId).execute();
		return result;
	});
	const mediaFiles = await deleteUnclaimed(media);

	await recount(commented.map(c => c.scenario_id), []);
	invalidateHome();
	return { scenarios: scenarios.length, comments: Number(comments), mediaFiles };
}

/** Account deletion: everything cascades from the user row; their pictures go too, unless someone else has them among their uploads */
export async function deleteAccount(userId: string) {
	const scenarios = await db.selectFrom("scenarios").select("id").where("owner_id", "=", userId).execute();
	const votedScenarios = await db.selectFrom("scenario_votes").select("scenario_id").where("user_id", "=", userId).execute();
	const votedComments = await db.selectFrom("comment_votes").select("comment_id").where("user_id", "=", userId).execute();
	const commented = await db.selectFrom("comments").select("scenario_id").where("user_id", "=", userId).execute();
	const media = await db.selectFrom("media_uploads").select("hash").where("user_id", "=", userId).execute();

	await db.transaction().execute(async trx => {
		for (const s of scenarios) await unindexScenario(trx, s.id);
		await trx.deleteFrom("users").where("id", "=", userId).execute();
	});
	await deleteUnclaimed(media.map(m => m.hash));

	await recount(
		[...votedScenarios.map(v => v.scenario_id), ...commented.map(c => c.scenario_id)],
		votedComments.map(v => v.comment_id)
	);
	invalidateHome();
}
