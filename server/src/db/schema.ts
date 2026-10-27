import type { Generated, Selectable } from "kysely";

export type Database = {
	users:          UsersTable,
	identities:     IdentitiesTable,
	sessions:       SessionsTable,
	invites:        InvitesTable,
	scenarios:      ScenariosTable,
	scenario_votes: VotesTable & { scenario_id: string },
	comments:       CommentsTable,
	comment_votes:  VotesTable & { comment_id: number },
	notifications:  NotificationsTable,
	media:          MediaTable,
	sync:           SyncTable
};

export type UsersTable = {
	id: string,
	username: string,
	bio: Generated<string>,
	/** media hash */
	icon: string | null,
	/** JSON string[] */
	hidden_tags: Generated<string>,
	is_creator: Generated<number>,
	is_admin: Generated<number>,
	banned_at: number | null,
	terms_accepted_at: number | null,
	created_at: number,
	last_seen_at: number | null
};
export type User = Selectable<UsersTable>;

export type IdentitiesTable = {
	provider: string,
	subject: string,
	user_id: string,
	login: string,
	created_at: number
};

export type SessionsTable = {
	/** sha256 of the cookie token */
	id: string,
	user_id: string,
	created_at: number,
	last_seen_at: number,
	user_agent: string
};

export type InvitesTable = {
	token: string,
	note: Generated<string>,
	created_at: number,
	created_by: string | null,
	used_by: string | null,
	used_at: number | null
};

export type ScenariosTable = {
	id: string,
	owner_id: string,
	parent_id: string | null,
	/** JSON user id[], original author first */
	authors: string,
	title: string,
	snippet: string,
	/** JSON string[] */
	tags: string,
	character_name: string,
	token_count: number,
	/** media hashes */
	card_picture: string | null,
	chat_picture: string | null,
	/** card JSON; pictures are media hashes, author fields stripped */
	data: string,
	score: Generated<number>,
	comment_count: Generated<number>,
	published_at: number,
	updated_at: number,
	delisted_at: number | null
};
export type ScenarioRow = Selectable<ScenariosTable>;

type VotesTable = {
	user_id: string,
	value: number
};

export type CommentsTable = {
	id: Generated<number>,
	scenario_id: string,
	user_id: string | null,
	body: string,
	ip_hash: string | null,
	score: Generated<number>,
	created_at: number
};

export type NotificationsTable = {
	id: Generated<number>,
	user_id: string,
	kind: "mention" | "comment",
	actor_id: string | null,
	scenario_id: string,
	comment_id: number,
	created_at: number,
	read_at: number | null
};

export type MediaTable = {
	hash: string,
	owner_id: string | null,
	bytes: number,
	width: number,
	height: number,
	created_at: number
};

export type SyncTable = {
	user_id: string,
	chat_id: string,
	/** gzipped SyncPayload JSON */
	payload: Uint8Array,
	bytes: number,
	name: string,
	persona_name: string,
	picture: string | null,
	message_count: number,
	last_update: number,
	uploaded_at: number
};
