import { Kysely, sql } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";

const init: Migration = {
	async up(db) {
		const statements = [
			`create table users (
				id                text primary key,
				username          text not null unique collate nocase,
				bio               text not null default '',
				icon              text,
				hidden_tags       text not null default '[]',
				is_creator        integer not null default 0,
				is_admin          integer not null default 0,
				banned_at         integer,
				terms_accepted_at integer,
				created_at        integer not null,
				last_seen_at      integer
			)`,
			`create table identities (
				provider   text not null,
				subject    text not null,
				user_id    text not null references users(id) on delete cascade,
				login      text not null,
				created_at integer not null,
				primary key (provider, subject)
			)`,
			`create index identities_user on identities(user_id)`,
			`create table sessions (
				id           text primary key,
				user_id      text not null references users(id) on delete cascade,
				created_at   integer not null,
				last_seen_at integer not null,
				user_agent   text not null default ''
			)`,
			`create index sessions_user on sessions(user_id)`,
			`create table invites (
				token      text primary key,
				note       text not null default '',
				created_at integer not null,
				created_by text references users(id) on delete set null,
				used_by    text references users(id) on delete set null,
				used_at    integer
			)`,
			`create table scenarios (
				id             text primary key,
				owner_id       text not null references users(id) on delete cascade,
				parent_id      text,
				authors        text not null,
				title          text not null,
				snippet        text not null,
				tags           text not null,
				character_name text not null,
				token_count    integer not null,
				card_picture   text,
				chat_picture   text,
				data           text not null,
				score          integer not null default 0,
				comment_count  integer not null default 0,
				published_at   integer not null,
				updated_at     integer not null,
				delisted_at    integer
			)`,
			`create index scenarios_owner     on scenarios(owner_id)`,
			`create index scenarios_updated   on scenarios(delisted_at, updated_at)`,
			`create index scenarios_published on scenarios(delisted_at, published_at)`,
			`create index scenarios_score     on scenarios(delisted_at, score)`,
			`create virtual table scenarios_fts using fts5(
				id unindexed, title, description, tags, character, authors, definition, openings,
				tokenize = "unicode61 remove_diacritics 2"
			)`,
			`create table scenario_votes (
				user_id     text not null references users(id) on delete cascade,
				scenario_id text not null references scenarios(id) on delete cascade,
				value       integer not null,
				primary key (user_id, scenario_id)
			)`,
			`create index scenario_votes_scenario on scenario_votes(scenario_id)`,
			`create table comments (
				id          integer primary key autoincrement,
				scenario_id text not null references scenarios(id) on delete cascade,
				user_id     text references users(id) on delete cascade,
				body        text not null,
				ip_hash     text,
				score       integer not null default 0,
				created_at  integer not null
			)`,
			`create index comments_scenario on comments(scenario_id, created_at)`,
			`create index comments_user     on comments(user_id, created_at)`,
			`create table comment_votes (
				user_id    text not null references users(id) on delete cascade,
				comment_id integer not null references comments(id) on delete cascade,
				value      integer not null,
				primary key (user_id, comment_id)
			)`,
			`create index comment_votes_comment on comment_votes(comment_id)`,
			`create table notifications (
				id          integer primary key autoincrement,
				user_id     text not null references users(id) on delete cascade,
				kind        text not null,
				actor_id    text references users(id) on delete set null,
				scenario_id text not null references scenarios(id) on delete cascade,
				comment_id  integer not null references comments(id) on delete cascade,
				created_at  integer not null,
				read_at     integer
			)`,
			`create index notifications_user on notifications(user_id, created_at)`,
			`create table media (
				hash       text primary key,
				owner_id   text references users(id) on delete set null,
				bytes      integer not null,
				width      integer not null,
				height     integer not null,
				created_at integer not null
			)`,
			`create index media_owner on media(owner_id)`,
			`create table sync (
				user_id       text not null references users(id) on delete cascade,
				chat_id       text not null,
				payload       blob not null,
				bytes         integer not null,
				name          text not null,
				persona_name  text not null,
				picture       text,
				message_count integer not null,
				last_update   integer not null,
				uploaded_at   integer not null,
				primary key (user_id, chat_id)
			)`
		];
		for (const s of statements) await sql.raw(s).execute(db);
	}
};

const migrations: Record<string, Migration> = {
	"0001_init": init
};

const provider: MigrationProvider = {
	getMigrations: async () => migrations
};

export async function migrate(db: Kysely<any>) {
	const migrator = new Migrator({ db, provider });
	const { error, results } = await migrator.migrateToLatest();
	for (const r of results ?? []) {
		if (r.status === "Error") console.error(`migration ${r.migrationName} failed`);
		else if (r.status === "Success") console.log(`migration ${r.migrationName} applied`);
	}
	if (error) throw error;
}
