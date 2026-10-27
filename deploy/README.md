# Deploying Kawakaze on Ubuntu

Assumes Ubuntu 24.04, a domain pointing at the VPS, and the repo at `/srv/kawakaze`.

1. Node 24 and nginx:
   ```
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
   sudo apt install -y nodejs nginx certbot python3-certbot-nginx sqlite3
   ```
2. User and code:
   ```
   sudo useradd --system --home /srv/kawakaze --shell /usr/sbin/nologin kawakaze
   sudo git clone <repo> /srv/kawakaze && cd /srv/kawakaze
   npm ci && npm run build
   sudo mkdir -p data && sudo chown -R kawakaze:kawakaze data
   ```
3. Config: `cp .env.example .env`, then set `PUBLIC_URL=https://your.domain`, `SECRET`, OAuth and Turnstile keys.
   Remove `SERVE_STATIC` and `DEV_LOGIN`. OAuth callbacks are `https://your.domain/auth/github/callback` and
   `https://your.domain/auth/google/callback`.
4. Service: `sudo cp deploy/kawakaze.service /etc/systemd/system/ && sudo systemctl enable --now kawakaze`.
   Logs: `journalctl -u kawakaze -f`.
5. nginx: copy `deploy/nginx.conf` to `/etc/nginx/sites-available/kawakaze`, replace the domain, link it into
   `sites-enabled`, run `sudo certbot --nginx -d your.domain`, then `sudo nginx -t && sudo systemctl reload nginx`.
   nginx needs read access to `/srv/kawakaze/web` and `/srv/kawakaze/data/media`.
6. Admin: sign in once on the site, then
   `sudo -u kawakaze npm run cli -- admin <username>`. Invites: `npm run cli -- invite 5 friends` or the admin page.

## Updating

```
cd /srv/kawakaze && git pull && npm ci && npm run build && sudo systemctl restart kawakaze
```
Migrations run on startup.

## Backups

The database is in WAL mode; copy it with sqlite's online backup rather than `cp`:
```
sqlite3 /srv/kawakaze/data/kawakaze.db ".backup '/var/backups/kawakaze/kawakaze-$(date +%F).db'"
```
plus `data/media/` (content-addressed, safe to rsync incrementally). A nightly cron entry running both is enough.
