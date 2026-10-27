# Kawakaze

A hosted, community edition of [Ägir](references/agir): creators publish scenario cards, everyone browses,
downloads and plays them locally with their own LLM provider. Chats, personas and provider keys never leave
the device unless the user explicitly moves a chat through sync.

Non-commercial. All published user content is shared under the WTFPL. No privacy guarantees.

## Stack

- Server: TypeScript, Hono on `@hono/node-server`, Kysely over `node:sqlite` (custom dialect), `sharp` for images.
  Node 24 LTS. Bundled with esbuild into `dist/server.js`.
- Frontend: vanilla TS, copied once from Ägir (rampike, marked, dompurify, tokenx). Bundled with esbuild.
- Ubuntu VPS: nginx in front (TLS, static `/assets` and `/media`), node behind it under systemd.

## Layout

```
shared/      types used by both sides (scenario format, API payloads)
server/src/  Hono app, db, auth, routes, cli
web/         index.html, assets/, src/ (Ägir fork)
deploy/      nginx and systemd samples
data/        runtime: kawakaze.db, media/ (gitignored)
```

## Scenario format

Kawakaze scenarios are Ägir `ScenarioCard`s with extra top-level properties. Ägir keeps unknown properties on
import, so files move between the two freely.

```ts
type KawaScenarioCard = ScenarioCard & {
	"kawa-snippet"?: { summary: string },        // plain text, <= 420 chars; required to publish
	"kawa-authors"?: { name: string, url: string }[] // filled by the server, original author first
};
```

- `card.author` is managed by the server on publish: the publishing user, `url` pointing to their user page.
  The editor no longer exposes author fields.
- Picture refs are either local media ids (IndexedDB) or absolute URLs of server media
  (`https://<host>/media/<sha256>.webp`). Ägir is being patched to treat `http(s)` refs as URLs.
- `lastUpdate` of a downloaded card is the server's `updatedAt`; this drives "update available" badges.

## Accounts

- Sign in with GitHub or Google (OAuth code flow, done by hand with `fetch`). Identities are not merged by email.
- Username is derived from the provider login on first sign-in (deduplicated), editable later. Case-insensitive unique,
  `[a-zA-Z0-9_-]{3,24}`.
- Sessions: random token in an `HttpOnly; SameSite=Lax; Secure` cookie, sha256 stored in db. Listed on the profile
  with revoke; "sign out" revokes the current one.
- Roles: `creator` (via single-use invite token + ToS acceptance), `admin` (granted with the CLI). Banned users
  can't sign in; their sessions are dropped.
- Users can delete their account: identities, sessions, votes, notifications, sync data, scenarios and comments go.
  Media files stay (local chats may reference them) until an admin purge.

## Media

- Only signed-in users upload. Client converts to WebP (`optimizer.ts`), server re-encodes with sharp anyway
  (smaller side <= 2048, metadata stripped, quality 90) and stores `data/media/<sha256>.webp`, deduplicated.
- One publish request carries at most two new pictures (card + chat icon); profile icon is its own request.
- Media is never deleted on scenario update or delist (local chats keep referencing it). Only admin purge deletes it.
- Per-user disk usage = media they uploaded + sync storage. Soft quotas from env, shown in the admin page.

## Publishing

- Creators publish from the local library editor. Publish = multipart `card` JSON + up to two picture files.
- Unknown id → new scenario owned by the caller. Own id → update. Someone else's id → fork: new id, `parentId` set,
  authors = parent's authors + caller. Client re-keys its local copy to the returned id.
- Delist hides a scenario from listings, search and the public endpoint (410). Updating it again relists.
- Server stores the full card JSON with media refs; listings are served from extracted columns.

## Public API (selected)

- `GET /api/scenarios?sort=updated|published|score&q=&fields=&page=` — cards: id, title, snippet, tags, pictures,
  authors, score, updatedAt, publishedAt, tokenCount, characterName.
- `GET /api/scenarios/:id` — full Ägir-compatible card JSON, public, CORS `*`. `?inline=1` embeds pictures as
  base64 (what Ägir's importer expects).
- `GET /api/users/:username` — public profile + their scenarios.
- Everything else is under `/api` with the session cookie; mutations require same-origin (hono csrf).

## Homepage

Grid of cards showing `kawa-snippet` instead of the description. Search (server FTS5 over title, description,
tags, character name, authors, definition, openings, with Ägir's field toggles), sort by last edit (default),
publish time, score. Server inlines the first page of the default query into `index.html` as JSON; the result
is cached in memory and invalidated on publish/update/delist/vote.

Users can list "hidden content" tags (profile for signed-in, local setting for anonymous). Cards with those tags
render under a cover with a reveal button.

## Scenario page `/c/:id`

Title, authors (linked), score with up/down votes, description (markdown), definition (plain text) under a
spoiler with a nested spoiler per opening, play button (downloads into the local library, then the start modal),
comment form with the current user preview, comments.

## Comments

- Plain text. Anonymous comments require Cloudflare Turnstile (skipped for signed-in users) and are rate limited
  per IP hash.
- A reply is a comment mentioning `@username`. Mentions notify the mentioned user; new comments notify the
  scenario owner. Notifications are polled, no SSE.
- Signed-in users vote on comments. Authors, scenario owners and admins delete comments.

## User page `/u/:username`

Icon, name, bio (markdown), published scenarios.

## Profile `/profile`

Signed out: sign-in buttons. Signed in, five tabs:
1. Profile: username, icon, bio, hidden tags.
2. Comments: own comments, each linking to its place.
3. Characters (creators): own published scenarios with "open in editor" (pulls into local library if missing).
   Non-creators: invite token form, ToS checkbox, explicit WTFPL notice.
4. Notifications.
5. Sessions: list, revoke, sign out; delete account.

## Local library `/library`, chats `/chats`, settings `/settings`

Ägir's, with additions:
- Library cards show published state / update available / "yours". Editor gains snippet, publish/update/delist.
- Chat list merges sync handles: "download" or "update" before playing. Download imports and deletes the server copy.
- Settings: Ägir's, plus hidden tags (anonymous), backups with inlined media.

## Play `/play/:id`

Ägir's chat, fullscreen. Context menu gains "Upload to sync" for signed-in users.

## Chat sync

Manual device migration, not live sync. Upload stores one gzipped payload per (user, chat id):
`{ chat, contents, media }` with local media inlined as base64 (server media stays as URLs).
Download imports it locally and deletes it from the server.

## Backups

Same structure as Ägir (`{ idb: {...stores}, local: {...} }`, identical store names). Media referenced by URL is
fetched and inlined as media entries whose `id` is the URL itself, so unpatched Ägir still resolves them.
Kawakaze-only data goes under a top-level `kawa` key. No auth data.

## Admin `/admin`

Disk report (db, media, sync, free space), invite issuing and listing, users table (scenarios, comments, disk
usage, created, last seen) with ban/unban and purge (delete scenarios, comments, media), recent comments with delete.

## Routing

Path routes everywhere (`/`, `/library`, `/chats`, `/settings`, `/profile`, `/admin`, `/editor/:id?`,
`/play/:id`, `/c/:id`, `/u/:name`, `/terms`). The server serves the SPA shell for all of them and injects
Open Graph tags for `/c/:id` and `/u/:name`.

## Shell injection and config

- The server reads `web/index.html` once and, per request, replaces the literal `<!--kawa-head-->` with
  OG/title tags plus `<script id="kawa-boot" type="application/json">BootPayload</script>` (`<` escaped).
  It also replaces `<title>Kawakaze</title>` on `/c/:id` and `/u/:name`.
- In dev (`SERVE_STATIC=1`) node also serves `/assets/*`, `/favicon.png` from `web/` and `/media/*` from
  `DATA_DIR/media`. In production nginx does.
- Env: `PORT`, `PUBLIC_URL`, `DATA_DIR`, `WEB_DIR`, `SECRET` (ip hashing), `GITHUB_CLIENT_ID/SECRET`,
  `GOOGLE_CLIENT_ID/SECRET`, `TURNSTILE_SITE_KEY/SECRET`, `QUOTA_MEDIA_MB`, `QUOTA_SYNC_MB`, `SERVE_STATIC`,
  `DEV_LOGIN` (enables `/auth/dev?username=` on localhost only, for local testing without OAuth apps).
- CLI (`npm run cli -- ...`): `admin <username>`, `invite [count] [note]`, `migrate`.

## Terms of use (summary)

No illegal content. You must have the rights to what you upload; published content is shared under WTFPL and
forks are explicitly allowed. Non-commercial service, self-promotion is fine. No privacy guarantees, no uptime
guarantees, admins may remove content and accounts.
