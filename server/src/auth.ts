import crypto from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config, oauthProviders } from "./config";
import { db } from "./db";
import type { User } from "./db/schema";
import { freeUsername } from "./users";
import { fail, randomToken, sha256 } from "./util";

export type AppEnv = {
	Variables: {
		user: User | null,
		sessionId: string | null
	}
};

const SESSION_COOKIE = "kawa_session";
const OAUTH_COOKIE = "kawa_oauth";
const SESSION_TTL_S = 365 * 24 * 60 * 60;
const SEEN_THROTTLE_MS = 5 * 60 * 1000;

export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
	c.set("user", null);
	c.set("sessionId", null);

	const token = getCookie(c, SESSION_COOKIE);
	if (token) {
		const id = sha256(token);
		const row = await db
			.selectFrom("sessions")
			.innerJoin("users", "users.id", "sessions.user_id")
			.selectAll("users")
			.select("sessions.last_seen_at as session_seen")
			.where("sessions.id", "=", id)
			.executeTakeFirst();

		if (!row) {
			deleteCookie(c, SESSION_COOKIE, { path: "/" });
		} else if (row.banned_at) {
			await db.deleteFrom("sessions").where("user_id", "=", row.id).execute();
			deleteCookie(c, SESSION_COOKIE, { path: "/" });
		} else {
			const { session_seen, ...user } = row;
			c.set("user", user);
			c.set("sessionId", id);
			const now = Date.now();
			if (now - session_seen > SEEN_THROTTLE_MS) {
				await db.updateTable("sessions").set({ last_seen_at: now }).where("id", "=", id).execute();
				await db.updateTable("users").set({ last_seen_at: now }).where("id", "=", user.id).execute();
			}
		}
	}
	await next();
};

export function requireUser(c: Context<AppEnv>) {
	const user = c.get("user");
	if (!user) fail(401, "sign in required");
	return user;
}
export function requireCreator(c: Context<AppEnv>) {
	const user = requireUser(c);
	if (!user.is_creator) fail(403, "creators only");
	return user;
}
export function requireAdmin(c: Context<AppEnv>) {
	const user = requireUser(c);
	if (!user.is_admin) fail(403, "admins only");
	return user;
}

async function createSession(c: Context<AppEnv>, userId: string) {
	const token = randomToken();
	const now = Date.now();
	await db
		.insertInto("sessions")
		.values({
			id: sha256(token),
			user_id: userId,
			created_at: now,
			last_seen_at: now,
			user_agent: (c.req.header("user-agent") ?? "").slice(0, 256)
		})
		.execute();
	await db.updateTable("users").set({ last_seen_at: now }).where("id", "=", userId).execute();
	setCookie(c, SESSION_COOKIE, token, {
		path: "/",
		httpOnly: true,
		secure: config.secure,
		sameSite: "Lax",
		maxAge: SESSION_TTL_S
	});
}

export async function signOut(c: Context<AppEnv>) {
	const id = c.get("sessionId");
	if (id) await db.deleteFrom("sessions").where("id", "=", id).execute();
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

type Identity = { provider: string, subject: string, login: string };

/** Identity -> user id, creating the user on first sign-in. null when banned */
async function resolveIdentity(identity: Identity): Promise<string | null> {
	const existing = await db
		.selectFrom("identities")
		.innerJoin("users", "users.id", "identities.user_id")
		.select(["users.id", "users.banned_at"])
		.where("identities.provider", "=", identity.provider)
		.where("identities.subject", "=", identity.subject)
		.executeTakeFirst();
	if (existing) {
		await db
			.updateTable("identities")
			.set({ login: identity.login })
			.where("provider", "=", identity.provider)
			.where("subject", "=", identity.subject)
			.execute();
		return existing.banned_at ? null : existing.id;
	}

	const id = crypto.randomUUID();
	const now = Date.now();
	const username = await freeUsername(identity.login);
	await db.transaction().execute(async trx => {
		await trx
			.insertInto("users")
			.values({ id, username, icon: null, banned_at: null, terms_accepted_at: null, created_at: now, last_seen_at: now })
			.execute();
		await trx
			.insertInto("identities")
			.values({ ...identity, user_id: id, created_at: now })
			.execute();
	});
	return id;
}

function safeNext(next: string | undefined) {
	if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/profile";
	return next;
}

type OAuthState = { provider: string, state: string, verifier: string, next: string };

function redirectUri(provider: string) {
	return `${config.publicUrl}/auth/${provider}/callback`;
}

export const authRoutes = new Hono<AppEnv>();

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Local testing without OAuth apps: only when enabled and both the public URL and the request are local */
authRoutes.get("/dev", async c => {
	const local = LOCAL_HOSTS.includes(new URL(c.req.url).hostname) && LOCAL_HOSTS.includes(new URL(config.publicUrl).hostname);
	if (!config.devLogin || !local) return c.notFound();
	const username = c.req.query("username") || "dev";
	const userId = await resolveIdentity({ provider: "dev", subject: username.toLowerCase(), login: username });
	if (!userId) return c.redirect("/profile?error=banned");
	await createSession(c, userId);
	return c.redirect(safeNext(c.req.query("next")));
});

authRoutes.get("/:provider", async c => {
	const provider = c.req.param("provider");
	if (!oauthProviders().includes(provider as any)) return c.notFound();

	const state: OAuthState = {
		provider,
		state: randomToken(16),
		verifier: randomToken(32),
		next: safeNext(c.req.query("next"))
	};
	setCookie(c, OAUTH_COOKIE, JSON.stringify(state), {
		path: "/auth",
		httpOnly: true,
		secure: config.secure,
		sameSite: "Lax",
		maxAge: 600
	});

	if (provider === "github") {
		const url = new URL("https://github.com/login/oauth/authorize");
		url.searchParams.set("client_id", config.github.id);
		url.searchParams.set("redirect_uri", redirectUri(provider));
		url.searchParams.set("state", state.state);
		url.searchParams.set("scope", "read:user");
		url.searchParams.set("allow_signup", "true");
		return c.redirect(url.toString());
	} else {
		const challenge = crypto.createHash("sha256").update(state.verifier).digest("base64url");
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		url.searchParams.set("client_id", config.google.id);
		url.searchParams.set("redirect_uri", redirectUri(provider));
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", "openid profile");
		url.searchParams.set("state", state.state);
		url.searchParams.set("code_challenge", challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("prompt", "select_account");
		return c.redirect(url.toString());
	}
});

authRoutes.get("/:provider/callback", async c => {
	const provider = c.req.param("provider");
	const raw = getCookie(c, OAUTH_COOKIE);
	deleteCookie(c, OAUTH_COOKIE, { path: "/auth" });

	let saved: OAuthState | null = null;
	try {
		saved = raw ? JSON.parse(raw) : null;
	} catch {}
	const code = c.req.query("code");
	if (!saved || saved.provider !== provider || saved.state !== c.req.query("state") || !code)
		return c.redirect("/profile?error=failed");

	let identity: Identity | null = null;
	try {
		identity = provider === "github"
			? await githubIdentity(code)
			: provider === "google"
				? await googleIdentity(code, saved.verifier)
				: null;
	} catch (e) {
		console.error("oauth failed", e);
	}
	if (!identity) return c.redirect("/profile?error=failed");

	const userId = await resolveIdentity(identity);
	if (!userId) return c.redirect("/profile?error=banned");
	await createSession(c, userId);
	return c.redirect(saved.next);
});

async function githubIdentity(code: string): Promise<Identity | null> {
	const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: config.github.id,
			client_secret: config.github.secret,
			code,
			redirect_uri: redirectUri("github")
		})
	});
	const token = await tokenResponse.json() as { access_token?: string };
	if (!token.access_token) return null;

	const userResponse = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${token.access_token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "kawakaze"
		}
	});
	if (!userResponse.ok) return null;
	const user = await userResponse.json() as { id?: number, login?: string };
	if (!user.id) return null;
	return { provider: "github", subject: String(user.id), login: user.login ?? "" };
}

async function googleIdentity(code: string, verifier: string): Promise<Identity | null> {
	const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: config.google.id,
			client_secret: config.google.secret,
			redirect_uri: redirectUri("google"),
			grant_type: "authorization_code",
			code_verifier: verifier
		})
	});
	const token = await tokenResponse.json() as { access_token?: string };
	if (!token.access_token) return null;

	const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
		headers: { Authorization: `Bearer ${token.access_token}` }
	});
	if (!userResponse.ok) return null;
	const user = await userResponse.json() as { sub?: string, name?: string, given_name?: string };
	if (!user.sub) return null;
	return { provider: "google", subject: user.sub, login: user.given_name || user.name || "" };
}
