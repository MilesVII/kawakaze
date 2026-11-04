#!/bin/sh
# Pulls the latest code, rebuilds and restarts the app. Run from /opt/kawakaze.
set -e
git stash
git pull
npm ci
npm run build
# tag list edits ship with the code: bring published cards in line (edit timestamps stay)
npm run cli -- retag
# the app keeps index.html in memory and runs the old dist/main.js until restarted
sudo systemctl restart kawakaze
# only needed when deploy/nginx.conf changed
sudo nginx -t && sudo systemctl reload nginx
