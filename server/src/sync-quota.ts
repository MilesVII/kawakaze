import { sql } from "kysely";
import { db } from "./db";

const SUM = sql<number>`coalesce(sum(bytes), 0)`.as("used");

/** Bytes a user keeps in chat and card sync together, leaving out the upload about to be replaced */
export async function syncBytesUsed(userId: string, replacing: { table: "sync" | "card_sync", id: string }) {
	const chats = await db
		.selectFrom("sync")
		.select(SUM)
		.where("user_id", "=", userId)
		.where("chat_id", "!=", replacing.table === "sync" ? replacing.id : "")
		.executeTakeFirstOrThrow();
	const cards = await db
		.selectFrom("card_sync")
		.select(SUM)
		.where("user_id", "=", userId)
		.where("card_id", "!=", replacing.table === "card_sync" ? replacing.id : "")
		.executeTakeFirstOrThrow();
	return chats.used + cards.used;
}
