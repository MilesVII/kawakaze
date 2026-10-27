import crypto from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Page } from "@shared/api";
import { PER_PAGE } from "@shared/api";
import { config } from "./config";

/** Thrown from handlers, rendered as `{ error }` by the app's error handler */
export class HttpError extends Error {
	constructor(public status: ContentfulStatusCode, message: string) {
		super(message);
	}
}
export function fail(status: ContentfulStatusCode, message: string): never {
	throw new HttpError(status, message);
}
export function ensure<T>(value: T, status: ContentfulStatusCode, message: string): NonNullable<T> {
	if (value === null || value === undefined || value === false) fail(status, message);
	return value as NonNullable<T>;
}

export function sha256(data: string | Uint8Array) {
	return crypto.createHash("sha256").update(data).digest("hex");
}
export function randomToken(bytes = 32) {
	return crypto.randomBytes(bytes).toString("base64url");
}

export function hashIP(ip: string | null) {
	if (!ip) return null;
	return crypto.createHmac("sha256", config.secret).update(ip).digest("hex").slice(0, 24);
}
export function clientIP(c: Context) {
	// nginx sets X-Real-IP; in dev there is no proxy
	const real = c.req.header("x-real-ip");
	if (real) return real;
	const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
	if (forwarded) return forwarded;
	const incoming = (c.env as any)?.incoming;
	return incoming?.socket?.remoteAddress ?? null;
}

export function parseJSON<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export async function readJSON(c: Context): Promise<any> {
	try {
		return await c.req.json();
	} catch {
		fail(400, "invalid JSON body");
	}
}

export function pageParam(c: Context) {
	const page = parseInt(c.req.query("page") ?? "0", 10);
	return isNaN(page) || page < 0 ? 0 : Math.min(page, 10_000);
}
export function makePage<T>(items: T[], page: number, totalItems: number, perPage = PER_PAGE): Page<T> {
	return {
		items,
		page,
		perPage,
		totalItems,
		totalPages: Math.ceil(totalItems / perPage)
	};
}

export function isString(v: unknown): v is string {
	return typeof v === "string";
}
export function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every(isString);
}
export function clampVote(v: unknown): -1 | 0 | 1 {
	return v === 1 ? 1 : v === -1 ? -1 : 0;
}

export const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
