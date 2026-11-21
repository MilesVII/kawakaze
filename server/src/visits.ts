import type { Context } from "hono";
import { sql } from "kysely";
import { db } from "./db";
import { clientIP, hashIP } from "./util";

/*
Unique daily visitors, out of curiosity rather than analytics: a page load (the SPA shell, not API calls or assets)
counts its IP once per UTC day. The IP is hashed together with the day, so stored hashes can't tie one day's visitor
to another day's, and only today's hashes are kept to count each visitor once; past days are just numbers in
visit_days. Crawlers and link previews that say so in their user agent aren't counted.
*/

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|go-http|headless/i;

// visitors already counted today, so repeat page loads don't touch the database
let today = "";
const seen = new Set<string>();

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export function countVisit(c: Context) {
	const agent = c.req.header("user-agent") ?? "";
	if (!agent || BOT_RE.test(agent)) return;
	const ip = clientIP(c);
	if (!ip) return;
	const day = dayOf(Date.now());
	if (day !== today) {
		today = day;
		seen.clear();
		db.deleteFrom("visitors").where("day", "<", day).execute().catch(e => console.error("visits: can't prune", e));
	}
	const visitor = hashIP(`${day} ${ip}`)!;
	if (seen.has(visitor)) return;
	seen.add(visitor);
	record(day, visitor).catch(e => console.error("visits: can't count", e));
}

async function record(day: string, visitor: string) {
	await db.transaction().execute(async trx => {
		// after a restart `seen` is empty, the table still knows
		const added = await trx
			.insertInto("visitors")
			.values({ day, visitor })
			.onConflict(oc => oc.doNothing())
			.executeTakeFirst();
		if (Number(added.numInsertedOrUpdatedRows ?? 0) === 0) return;
		await trx
			.insertInto("visit_days")
			.values({ day, visitors: 1 })
			.onConflict(oc => oc.column("day").doUpdateSet({ visitors: sql`visitors + 1` }))
			.execute();
	});
}

export async function visitorsOn(at: number) {
	const row = await db.selectFrom("visit_days").select("visitors").where("day", "=", dayOf(at)).executeTakeFirst();
	return row?.visitors ?? 0;
}

/** every counted day, oldest first */
export async function visitsCSV() {
	const rows = await db.selectFrom("visit_days").selectAll().orderBy("day", "asc").execute();
	return ["day,visitors", ...rows.map(r => `${r.day},${r.visitors}`)].join("\n") + "\n";
}
