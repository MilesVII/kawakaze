# Kawakaze

Hosted, community edition of [Ägir](https://github.com/MilesVII/agir): creators publish scenario cards, everyone
browses them and plays locally with their own LLM provider. See [SPEC.md](SPEC.md) for the design and
[shared/api.ts](shared/api.ts) for the API contract.

## Features

On top of everything Ägir does locally:

- A public catalog of scenario cards: full-text search, tags, sorting, votes and comments, with `@mentions` and notifications
- Publishing for creators (invite-only): cards credit their authors, and edits or forks of someone else's card keep the original credit
- User pages with bios, and a media library for uploaded pictures
- Hidden tags: cards with them are covered in the catalog until revealed
- Chat sync and card sync: move a chat or a library card to another device through the server. Downloading it removes the server copy
- A Datacat browser in the library: search [Datacat](https://datacat.run) or open a Janitor or Datacat link, and import characters straight into the library
- An admin panel: invites, users, comments, disk usage and client error reports

Chats, personas and provider keys stay on the device unless the user syncs a chat. A service worker
([web/sw.js](web/sw.js)) keeps the app working offline once it has been opened, so the library, chats and backups
stay reachable without a connection, and offers a reload when a new version is deployed.

## Development

```
npm install
cp .env.example .env    # dev defaults: SERVE_STATIC=1, DEV_LOGIN=1
npm run build
npm run dev             # http://localhost:8787
```

- Sign in without OAuth: `http://localhost:8787/auth/dev?username=you`
- `npm run typecheck` checks both `web/` and `server/`
- The Datacat browser needs `DATACAT_CLIENT_ID`, the public Client ID of an approved Datacat integration. Browsers
  send it, so never put a developer token (`dca1_`) there.

### CLI

`npm run cli -- <command>`, after `npm run build`:

| command | |
|---|---|
| `migrate` | apply database migrations |
| `admin <username>` / `unadmin <username>` | grant admin (and creator) rights, or revoke admin rights |
| `invite [count] [note]` | issue creator invite tokens, e.g. `invite 3 "for friends"` |
| `retag [--dry]` | rewrite published cards' tags with the current tag list and refresh the search index; `--dry` only lists the changes |
| `media reindex` | rebuild where pictures are used from every card and bio |

Production setup (nginx, systemd, OAuth apps) is in [deploy/README.md](deploy/README.md).
