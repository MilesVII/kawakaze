import path from "node:path";
import crypto from "node:crypto";

function env(key: string, fallback = "") {
	return process.env[key]?.trim() || fallback;
}
function envInt(key: string, fallback: number) {
	const v = parseInt(env(key), 10);
	return isNaN(v) ? fallback : v;
}
function flag(key: string) {
	return ["1", "true", "yes"].includes(env(key).toLowerCase());
}

const port = envInt("PORT", 8787);
const publicUrl = env("PUBLIC_URL", `http://localhost:${port}`).replace(/\/+$/, "");
const dataDir = path.resolve(env("DATA_DIR", "data"));

export const config = {
	port,
	publicUrl,
	publicOrigin: new URL(publicUrl).origin,
	secure: publicUrl.startsWith("https://"),
	dataDir,
	mediaDir: path.join(dataDir, "media"),
	dbPath: path.join(dataDir, "kawakaze.db"),
	webDir: path.resolve(env("WEB_DIR", "web")),
	/** ip hashing salt; without it hashes don't survive restarts, which is acceptable */
	secret: env("SECRET") || crypto.randomBytes(32).toString("hex"),
	github: {
		id:     env("GITHUB_CLIENT_ID"),
		secret: env("GITHUB_CLIENT_SECRET")
	},
	google: {
		id:     env("GOOGLE_CLIENT_ID"),
		secret: env("GOOGLE_CLIENT_SECRET")
	},
	turnstile: {
		siteKey: env("TURNSTILE_SITE_KEY"),
		secret:  env("TURNSTILE_SECRET")
	},
	quota: {
		mediaBytes: envInt("QUOTA_MEDIA_MB", 64) * 1024 * 1024,
		syncBytes:  envInt("QUOTA_SYNC_MB", 256) * 1024 * 1024
	},
	serveStatic: flag("SERVE_STATIC"),
	devLogin: flag("DEV_LOGIN")
};

export function oauthProviders() {
	const list: ("github" | "google")[] = [];
	if (config.github.id && config.github.secret) list.push("github");
	if (config.google.id && config.google.secret) list.push("google");
	return list;
}
