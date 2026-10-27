import { sql } from "kysely";
import type { Me, UserRef } from "@shared/api";
import { USERNAME_RE } from "@shared/api";
import { db } from "./db";
import type { User } from "./db/schema";
import { mediaUrl } from "./media";
import { parseJSON } from "./util";

export function userRef(u: Pick<User, "id" | "username" | "icon">): UserRef {
	return { id: u.id, username: u.username, icon: mediaUrl(u.icon) };
}

export function profileUrl(username: string) {
	return `/u/${encodeURIComponent(username)}`;
}

export async function toMe(u: User): Promise<Me> {
	const unread = await db
		.selectFrom("notifications")
		.select(sql<number>`count(*)`.as("n"))
		.where("user_id", "=", u.id)
		.where("read_at", "is", null)
		.executeTakeFirstOrThrow();
	return {
		...userRef(u),
		bio: u.bio,
		hiddenTags: parseJSON<string[]>(u.hidden_tags, []),
		isCreator: Boolean(u.is_creator),
		isAdmin: Boolean(u.is_admin),
		unread: unread.n,
		createdAt: u.created_at,
		termsAcceptedAt: u.terms_accepted_at
	};
}

/** Users by id, for resolving author lists and comment authors in one query */
export async function usersById(ids: Iterable<string>) {
	const unique = Array.from(new Set(ids));
	const map = new Map<string, UserRef>();
	if (unique.length === 0) return map;
	const rows = await db
		.selectFrom("users")
		.select(["id", "username", "icon"])
		.where("id", "in", unique)
		.execute();
	for (const r of rows) map.set(r.id, userRef(r));
	return map;
}

export async function findUserByName(username: string) {
	return await db
		.selectFrom("users")
		.selectAll()
		.where("username", "=", username) // column is collate nocase
		.executeTakeFirst();
}

/** Provider login -> a free username matching USERNAME_RE */
export async function freeUsername(seed: string) {
	let base = seed.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 18);
	if (base.length < 3) base = `user${base}`;
	if (USERNAME_RE.test(base) && !(await findUserByName(base))) return base;
	for (let i = 0; i < 50; ++i) {
		const candidate = `${base}${Math.floor(Math.random() * 10_000)}`;
		if (!(await findUserByName(candidate))) return candidate;
	}
	return `user${crypto.randomUUID().slice(0, 8)}`;
}
