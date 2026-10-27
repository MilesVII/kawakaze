# Kawakaze

Hosted, community edition of [Ägir](https://github.com/MilesVII/agir): creators publish scenario cards, everyone
browses them and plays locally with their own LLM provider. See [SPEC.md](SPEC.md) for the design and
[shared/api.ts](shared/api.ts) for the API contract.

## Development

```
npm install
cp .env.example .env    # dev defaults: SERVE_STATIC=1, DEV_LOGIN=1
npm run build
npm run dev             # http://localhost:8787
```

- Sign in without OAuth: `http://localhost:8787/auth/dev?username=you`
- Make yourself admin: `npm run cli -- admin you`
- Issue invites: `npm run cli -- invite 3 "for friends"`
- `npm run typecheck` checks both `web/` and `server/`

Production setup (nginx, systemd, OAuth apps) is in [deploy/README.md](deploy/README.md).
