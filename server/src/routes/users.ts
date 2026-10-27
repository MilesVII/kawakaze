import { Hono } from "hono";
import { sql } from "kysely";
import type { PublicUser } from "@shared/api";
import type { AppEnv } from "../auth";
import { authorsFor, toListItem } from "../catalog";
import { db } from "../db";
import { findUserByName, userRef } from "../users";
import { ensure } from "../util";

export const userRoutes = new Hono<AppEnv>();

export async function publicUser(username: string): Promise<PublicUser | null> {
	const user = await findUserByName(username);
	if (!user || user.banned_at) return null;
	// scenarios they own or co-authored through forks
	const rows = await db
		.selectFrom("scenarios")
		.selectAll()
		.where("delisted_at", "is", null)
		.where(eb => eb.or([
			eb("owner_id", "=", user.id),
			sql<boolean>`exists (select 1 from json_each(scenarios.authors) where json_each.value = ${user.id})`
		]))
		.orderBy("updated_at", "desc")
		.limit(500)
		.execute();
	const users = await authorsFor(rows);
	return {
		user: {
			...userRef(user),
			bio: user.bio,
			createdAt: user.created_at,
			isCreator: Boolean(user.is_creator)
		},
		scenarios: rows.map(r => toListItem(r, users))
	};
}

userRoutes.get("/:username", async c => {
	return c.json(ensure(await publicUser(c.req.param("username")), 404, "user not found"));
});
