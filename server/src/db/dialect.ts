import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
	CompiledQuery,
	DatabaseConnection,
	Dialect,
	Driver,
	Kysely,
	QueryResult,
	SelectQueryNode,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler
} from "kysely";

/*
Kysely dialect over node:sqlite. The database is synchronous and single-connection, so the driver hands
the connection out under a mutex: a transaction spanning several awaits must not interleave with other queries.
*/

export class NodeSqliteDialect implements Dialect {
	constructor(private db: DatabaseSync) {}
	createAdapter()       { return new SqliteAdapter(); }
	createDriver()        { return new NodeSqliteDriver(this.db); }
	createQueryCompiler() { return new SqliteQueryCompiler(); }
	createIntrospector(db: Kysely<any>) { return new SqliteIntrospector(db); }
}

class NodeSqliteDriver implements Driver {
	private connection: NodeSqliteConnection;
	private queue: Promise<void> = Promise.resolve();
	private release: (() => void) | null = null;

	constructor(private db: DatabaseSync) {
		this.connection = new NodeSqliteConnection(db);
	}

	async init() {}

	async acquireConnection() {
		const previous = this.queue;
		let release!: () => void;
		this.queue = new Promise(resolve => release = resolve);
		await previous;
		this.release = release;
		return this.connection;
	}
	async releaseConnection() {
		const release = this.release;
		this.release = null;
		release?.();
	}

	async beginTransaction(c: DatabaseConnection) {
		await c.executeQuery(CompiledQuery.raw("begin"));
	}
	async commitTransaction(c: DatabaseConnection) {
		await c.executeQuery(CompiledQuery.raw("commit"));
	}
	async rollbackTransaction(c: DatabaseConnection) {
		await c.executeQuery(CompiledQuery.raw("rollback"));
	}

	async destroy() {
		this.db.close();
	}
}

function bindable(v: unknown): SQLInputValue {
	if (v === undefined) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	return v as SQLInputValue;
}

class NodeSqliteConnection implements DatabaseConnection {
	constructor(private db: DatabaseSync) {}

	async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
		const statement = this.db.prepare(query.sql);
		const parameters = query.parameters.map(bindable);
		if (statement.columns().length > 0) {
			return { rows: statement.all(...parameters) as R[] };
		}
		const { changes, lastInsertRowid } = statement.run(...parameters);
		return {
			numAffectedRows: BigInt(changes),
			insertId: BigInt(lastInsertRowid),
			rows: []
		};
	}

	async *streamQuery<R>(query: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
		if (!SelectQueryNode.is(query.query)) throw new Error("only select queries can be streamed");
		const statement = this.db.prepare(query.sql);
		for (const row of statement.iterate(...query.parameters.map(bindable)))
			yield { rows: [row as R] };
	}
}
