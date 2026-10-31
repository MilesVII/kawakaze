/*
Contract between server/ and web/. Everything here is plain data: no runtime imports from either side.
All endpoints answer JSON; errors are `{ error: string }` with a 4xx/5xx status.
Timestamps are unix milliseconds. Picture/icon fields are absolute media URLs or null.
*/
import type { Chat, ChatContents, ScenarioCard } from "./aegir";

export const LIMITS = {
	snippet:   420,
	title:     200,
	bio:       4000,
	comment:   4000,
	tags:      32,
	tagLength: 48,
	hiddenTags: 64,
	/** serialized card JSON without pictures */
	cardBytes: 4 * 1024 * 1024,
	/** single uploaded picture, before re-encoding */
	pictureBytes: 12 * 1024 * 1024,
	/** single sync payload, as received */
	syncBytes: 64 * 1024 * 1024
} as const;
export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
/** tags are stored lowercase, without '#', with single spaces; duplicates dropped */
export function normalizeTags(tags: string[]) {
	const clean = tags.map(t => t.replace(/#/g, "").replace(/\s+/g, " ").trim().toLowerCase());
	return Array.from(new Set(clean.filter(t => t)));
}
export const MENTION_RE = /(^|[^a-zA-Z0-9_-])@([a-zA-Z0-9_-]{3,24})/g;
export const PER_PAGE = 24;

// ---- scenario format ----

export type KawaSnippet = { summary: string };
export type KawaAuthor = { name: string, url: string };
export type KawaScenarioCard = ScenarioCard & {
	"kawa-snippet"?: KawaSnippet,
	/** server-managed, original author first */
	"kawa-authors"?: KawaAuthor[],
	/** id of the card a local clone was made from; its first publish inherits that card's credit, then it's dropped */
	"kawa-source"?: string
};

// ---- common ----

export type Page<T> = {
	items: T[],
	page: number,
	perPage: number,
	totalItems: number,
	totalPages: number
};
export type UserRef = { id: string, username: string, icon: string | null };
export type Vote = -1 | 0 | 1;

/** Injected into index.html as <script id="kawa-boot" type="application/json"> */
export type BootPayload = {
	config: PublicConfig,
	/** first page of the default homepage query, only on `/` */
	home?: Page<ScenarioListItem>,
	stats?: SiteStats
};
/** GET /api/scenarios/stats — public counters shown above the homepage search */
export type SiteStats = {
	/** listed scenarios */
	scenarios: number,
	creators: number,
	comments: number
};
export type PublicConfig = {
	publicUrl: string,
	/** empty when Turnstile is not configured: anonymous comments are then disabled */
	turnstileSiteKey: string,
	oauth: ("github" | "google")[]
};

// ---- scenarios ----

export type ScenarioSort = "updated" | "published" | "score";
export type SearchField = "title" | "description" | "tags" | "character" | "authors" | "definition" | "openings";

/**
 * GET /api/scenarios?sort=&q=&fields=title,tags,...&page=0&tag=
 * No per-user data, so responses are cacheable.
 */
export type ScenarioListItem = {
	id: string,
	title: string,
	snippet: string,
	tags: string[],
	picture: string | null,
	characterName: string,
	tokenCount: number,
	authors: UserRef[],
	score: number,
	commentCount: number,
	publishedAt: number,
	updatedAt: number
};

/** GET /api/scenarios/:id/meta — the scenario page header */
export type ScenarioMeta = ScenarioListItem & {
	ownerId: string,
	parentId: string | null,
	delisted: boolean,
	myVote: Vote
};

/*
GET  /api/scenarios/:id           -> KawaScenarioCard (public, CORS *, 410 if delisted). ?inline=1 embeds pictures as base64
POST /api/scenarios               multipart: card=<KawaScenarioCard JSON>, cardPicture?=<file>, chatPicture?=<file>
                                  A picture part replaces that ref; otherwise the ref must be null or a server media URL.
                                  -> PublishResult
POST /api/scenarios/:id/delist    -> { ok: true } (owner or admin)
POST /api/scenarios/:id/vote      { value: Vote } -> { score: number, myVote: Vote }
POST /api/scenarios/lookup        { ids: string[] } -> { items: ScenarioLookup[] } (unknown ids are omitted)
*/
export type PublishResult = {
	id: string,
	forked: boolean,
	card: KawaScenarioCard
};
export type ScenarioLookup = {
	id: string,
	updatedAt: number,
	ownerId: string,
	delisted: boolean
};

// ---- comments ----

/*
GET    /api/scenarios/:id/comments?page=  -> Page<Comment>, newest first
POST   /api/scenarios/:id/comments        { body: string, turnstile?: string } -> Comment
DELETE /api/comments/:id                  -> { ok: true } (comment author, scenario owner, admin)
POST   /api/comments/:id/vote             { value: Vote } -> { score: number, myVote: Vote } (signed in)
*/
export type Comment = {
	id: number,
	scenarioId: string,
	/** null for anonymous */
	author: UserRef | null,
	body: string,
	createdAt: number,
	score: number,
	myVote: Vote,
	canDelete: boolean
};
export type CommentWithScenario = Comment & { scenarioTitle: string };

// ---- auth & me ----

/*
GET  /auth/:provider?next=/path   -> redirect to provider
GET  /auth/:provider/callback     -> sets cookie, redirects to `next` or /profile (or /profile?error=banned|failed)
POST /api/auth/signout            -> { ok: true }

GET    /api/me                    -> Me | null
PATCH  /api/me                    { username?, bio?, hiddenTags? } -> Me
PUT    /api/me/icon               multipart icon=<file> -> Me
DELETE /api/me/icon               -> Me
DELETE /api/me                    { confirm: <username> } -> { ok: true }
POST   /api/me/redeem             { token: string, acceptTerms: true } -> Me
GET    /api/me/comments?page=     -> Page<CommentWithScenario>
GET    /api/me/scenarios          -> ScenarioMeta[] (including delisted)
GET    /api/me/notifications?page= -> Page<Notification>
POST   /api/me/notifications/read { ids?: number[] } (all when omitted) -> { ok: true }
GET    /api/me/sessions           -> SessionInfo[]
DELETE /api/me/sessions/:id       -> { ok: true }
*/
export type Me = UserRef & {
	bio: string,
	hiddenTags: string[],
	isCreator: boolean,
	isAdmin: boolean,
	unread: number,
	createdAt: number,
	termsAcceptedAt: number | null
};
export type Notification = {
	id: number,
	kind: "mention" | "comment",
	createdAt: number,
	read: boolean,
	actor: UserRef | null,
	scenario: { id: string, title: string },
	comment: { id: number, body: string }
};
export type SessionInfo = {
	id: string,
	current: boolean,
	createdAt: number,
	lastSeenAt: number,
	userAgent: string
};

// ---- users ----

/** GET /api/users/:username */
export type PublicUser = {
	user: UserRef & { bio: string, createdAt: number, isCreator: boolean },
	scenarios: ScenarioListItem[]
};

// ---- chat sync ----

/*
GET    /api/sync       -> SyncHandle[]
PUT    /api/sync/:id   SyncPayload -> SyncHandle (replaces the previous upload of that chat)
GET    /api/sync/:id   -> SyncPayload
DELETE /api/sync/:id   -> { ok: true }
*/
export type SyncPayload = {
	chat: Chat,
	contents: ChatContents,
	/** local media referenced by the chat, base64 like Ägir's chat export */
	media: { id: string, mime: string, media: string }[]
};
export type SyncHandle = {
	id: string,
	name: string,
	personaName: string,
	/** only when the chat picture is a server media URL */
	picture: string | null,
	messageCount: number,
	lastUpdate: number,
	uploadedAt: number,
	bytes: number
};

// ---- admin ----

/*
GET    /api/admin/disk                -> DiskReport
GET    /api/admin/invites             -> Invite[]
POST   /api/admin/invites             { count: number, note?: string } -> Invite[]
DELETE /api/admin/invites/:token      -> { ok: true }
GET    /api/admin/users?q=&page=      -> Page<AdminUser>, heaviest disk users first
POST   /api/admin/users/:id/ban       { banned: boolean } -> AdminUser
POST   /api/admin/users/:id/creator   { creator: boolean } -> AdminUser
POST   /api/admin/users/:id/purge     -> PurgeResult (deletes scenarios, comments, media; does not ban)
GET    /api/admin/comments?page=      -> Page<AdminComment>
*/
export type DiskReport = {
	dbBytes: number,
	mediaBytes: number,
	mediaFiles: number,
	syncBytes: number,
	syncItems: number,
	freeBytes: number,
	totalBytes: number,
	users: number,
	creators: number,
	scenarios: number,
	comments: number
};
export type Invite = {
	token: string,
	note: string,
	createdAt: number,
	usedBy: UserRef | null,
	usedAt: number | null
};
export type AdminUser = UserRef & {
	createdAt: number,
	lastSeenAt: number | null,
	providers: string[],
	isCreator: boolean,
	isAdmin: boolean,
	banned: boolean,
	scenarioCount: number,
	commentCount: number,
	mediaBytes: number,
	syncBytes: number
};
export type PurgeResult = { scenarios: number, comments: number, mediaFiles: number };
export type AdminComment = CommentWithScenario & { ipHash: string | null };
