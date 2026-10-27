import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import type { PublicConfig } from "@shared/api";
import { LIMITS } from "@shared/api";
import { authRoutes, sessionMiddleware, signOut, type AppEnv } from "./auth";
import { config, oauthProviders } from "./config";
import { adminRoutes } from "./routes/admin";
import { commentRoutes } from "./routes/comments";
import { meRoutes } from "./routes/me";
import { scenarioRoutes } from "./routes/scenarios";
import { syncRoutes } from "./routes/sync";
import { userRoutes } from "./routes/users";
import { renderShell } from "./shell";
import { HttpError } from "./util";

const MULTIPART_SLACK = 64 * 1024;
const DEFAULT_BODY_LIMIT = 256 * 1024;

/** Per-route request size: big for publishing and sync, small for everything else */
function bodyLimitFor(method: string, path: string) {
	if (method === "POST" && path === "/api/scenarios") return LIMITS.cardBytes + 2 * LIMITS.pictureBytes + MULTIPART_SLACK;
	if (method === "PUT" && path === "/api/me/icon") return LIMITS.pictureBytes + MULTIPART_SLACK;
	if (method === "PUT" && path.startsWith("/api/sync/")) return LIMITS.syncBytes;
	return DEFAULT_BODY_LIMIT;
}

export function createApp() {
	const app = new Hono<AppEnv>();

	app.onError((e, c) => {
		if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
		if (e instanceof HTTPException) return c.json({ error: e.message || "request rejected" }, e.status);
		console.error(e);
		return c.json({ error: "internal error" }, 500);
	});

	app.use("/api/*", csrf({ origin: config.publicOrigin }));
	app.use("/api/*", async (c, next) => {
		if (c.req.method === "GET" || c.req.method === "HEAD") return next();
		const maxSize = bodyLimitFor(c.req.method, c.req.path);
		return bodyLimit({ maxSize, onError: c => c.json({ error: "request is too large" }, 413) })(c, next);
	});
	app.use("/api/*", sessionMiddleware);
	app.use("/api/*", async (c, next) => {
		await next();
		if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
	});

	app.get("/api/config", c => {
		const body: PublicConfig = {
			publicUrl: config.publicUrl,
			turnstileSiteKey: config.turnstile.secret ? config.turnstile.siteKey : "",
			oauth: oauthProviders()
		};
		return c.json(body);
	});
	app.post("/api/auth/signout", async c => {
		await signOut(c);
		return c.json({ ok: true });
	});
	app.route("/api/scenarios", scenarioRoutes);
	app.route("/api/me", meRoutes);
	app.route("/api/users", userRoutes);
	app.route("/api/sync", syncRoutes);
	app.route("/api/admin", adminRoutes);
	app.route("/api", commentRoutes);
	app.all("/api/*", c => c.json({ error: "not found" }, 404));

	app.route("/auth", authRoutes);

	if (config.serveStatic) {
		app.use("/assets/*", serveStatic({ root: config.webDir }));
		app.use("/favicon.png", serveStatic({ root: config.webDir }));
		app.use("/media/*", async (c, next) => {
			await next();
			if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
		});
		app.use("/media/*", serveStatic({ root: config.dataDir }));
	}
	app.get("/assets/*", c => c.text("not found", 404));
	app.get("/media/*", c => c.text("not found", 404));

	app.get("*", async c => {
		c.header("Cache-Control", "no-cache");
		return c.html(await renderShell(c.req.path));
	});

	return app;
}
