import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

/*
Content hashes of web/assets, for two things:
- the shell links CSS and JS as `/assets/x.css?v=<hash>`, so a changed file gets a new URL and no cache in
  between (browser, proxy, service worker) can hand out the old one;
- the service worker (web/sw.js) precaches the app with the same URLs and names its cache after `version`.
Production computes them once (an update restarts the app anyway); dev re-checks files by mtime on every use,
so watch rebuilds show up.
*/

export type AssetManifest = {
	/** changes whenever any asset does */
	version: string,
	/** what the service worker downloads on install, besides the shell */
	precache: string[],
	/** "/assets/css/main.css" -> "/assets/css/main.css?v=0123456789" for CSS and JS */
	versioned: Map<string, string>
};

const VERSIONED = /\.(css|js)$/;
// images load as they're needed; everything else is needed to start the app offline
const PRECACHED_IMAGES = new Set(["/assets/gfx/placeholder.png"]);
const LAZY = /\.(png|jpe?g|webp|gif)$/;

let manifest: AssetManifest | null = null;
const hashes = new Map<string, { mtimeMs: number, size: number, hash: string }>();

function fileHash(file: string) {
	const stat = fs.statSync(file);
	const known = hashes.get(file);
	if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.hash;
	const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 10);
	hashes.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
	return hash;
}

function listAssets(dir: string, prefix: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			// gfx/src holds sources of the pictures
			if (entry.name !== "src") out.push(...listAssets(path.join(dir, entry.name), `${prefix}/${entry.name}`));
		} else if (!entry.name.endsWith(".map")) {
			out.push(`${prefix}/${entry.name}`);
		}
	}
	return out;
}

export function assetManifest(): AssetManifest {
	if (manifest && !config.serveStatic) return manifest;

	const root = path.join(config.webDir, "assets");
	const files = listAssets(root, "/assets").sort();
	const versioned = new Map<string, string>();
	const precache: string[] = [];
	const all = crypto.createHash("sha256");
	for (const url of files) {
		const hash = fileHash(path.join(root, url.slice("/assets/".length)));
		all.update(`${url} ${hash}\n`);
		if (VERSIONED.test(url)) versioned.set(url, `${url}?v=${hash}`);
		if (!LAZY.test(url) || PRECACHED_IMAGES.has(url)) precache.push(versioned.get(url) ?? url);
	}
	precache.push("/favicon.png");

	manifest = { version: all.digest("hex").slice(0, 10), precache, versioned };
	return manifest;
}

/** Adds `?v=<hash>` to the shell's CSS and JS links */
export function versionAssetLinks(html: string) {
	const { versioned } = assetManifest();
	return html.replace(/(href|src)="(\/assets\/[^"?]+)"/g, (whole, attr: string, url: string) => {
		const v = versioned.get(url);
		return v ? `${attr}="${v}"` : whole;
	});
}

let swSource: string | null = null;
/** web/sw.js with the manifest it precaches */
export function serviceWorker() {
	if (!swSource || config.serveStatic) swSource = fs.readFileSync(path.join(config.webDir, "sw.js"), "utf8");
	const { version, precache } = assetManifest();
	return `const MANIFEST = ${JSON.stringify({ version, precache })};\n${swSource}`;
}
