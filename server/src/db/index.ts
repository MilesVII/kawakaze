import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Kysely } from "kysely";
import { config } from "../config";
import { NodeSqliteDialect } from "./dialect";
import { migrate } from "./migrations";
import type { Database } from "./schema";

fs.mkdirSync(config.mediaDir, { recursive: true });

export const sqlite = new DatabaseSync(config.dbPath);
sqlite.exec("pragma journal_mode = wal");
sqlite.exec("pragma synchronous = normal");
sqlite.exec("pragma foreign_keys = on");
sqlite.exec("pragma busy_timeout = 5000");

export const db = new Kysely<Database>({ dialect: new NodeSqliteDialect(sqlite) });

const dataVersion = sqlite.prepare("pragma data_version");
/** changes whenever another connection (the CLI, say) commits; this process's own writes leave it alone */
export function foreignDataVersion() {
	return Number((dataVersion.get() as { data_version: number }).data_version);
}

export async function initDB() {
	await migrate(db);
}
