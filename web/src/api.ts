import type { BootPayload, Me, PublicConfig } from "@shared/api";
import type { Result } from "./types";

/*
Thin fetch wrapper for the Kawakaze backend, plus the signed-in account state.
- api(): JSON or FormData in, Result out; never throws
- reachability: whether requests get through to the server, for the offline toast (units/kawa/connection.ts)
- account: current user, refreshed on demand and every minute while signed in
*/

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function api<T>(method: Method, path: string, body?: unknown): Promise<Result<T, string>> {
	const init: RequestInit = { method, credentials: "same-origin", headers: {} };
	if (body instanceof FormData) {
		init.body = body;
	} else if (body !== undefined) {
		init.body = JSON.stringify(body);
		(init.headers as Record<string, string>)["Content-Type"] = "application/json";
	}

	let response: Response;
	try {
		response = await fetch(path, init);
	} catch {
		noteReachable(false);
		return { success: false, error: "server can't be reached" };
	}
	// nginx answers these while the app is down
	noteReachable(response.status < 502 || response.status > 504);

	let payload: any = null;
	try {
		payload = await response.json();
	} catch {
		if (response.ok) return { success: true, value: null as T };
	}
	if (!response.ok)
		return { success: false, error: payload?.error ?? `server error ${response.status}` };
	return { success: true, value: payload as T };
}

let reachable: boolean | null = null;
const reachabilityListeners: ((reachable: boolean) => void)[] = [];
// requests the browser aborts while the page is being left fail like a lost connection
let leaving = false;
window.addEventListener("pagehide", () => { leaving = true; });
window.addEventListener("pageshow", () => { leaving = false; });

/** records whether the server answered; listeners hear only changes */
export function noteReachable(value: boolean) {
	if (leaving || value === reachable) return;
	reachable = value;
	reachabilityListeners.forEach(l => l(value));
}
export function onReachability(listener: (reachable: boolean) => void) {
	reachabilityListeners.push(listener);
}

let boot: BootPayload | null = null;
export function readBoot(): BootPayload {
	if (boot) return boot;
	const element = document.querySelector("#kawa-boot");
	try {
		boot = JSON.parse(element?.textContent ?? "");
	} catch {
		boot = null;
	}
	boot ??= {
		config: { publicUrl: window.location.origin, turnstileSiteKey: "", oauth: [], datacatClientId: "" },
		version: ""
	};
	return boot;
}
export function config(): PublicConfig {
	return readBoot().config;
}
/** the inlined homepage is only valid for the first render */
export function takeBootHome() {
	const b = readBoot();
	const home = b.home ?? null;
	delete b.home;
	return home;
}

type MeListener = (me: Me | null) => void;
const meListeners: MeListener[] = [];
let me: Me | null = null;
let meLoaded = false;
let mePromise: Promise<Me | null> | null = null;
let pollTimer: number | null = null;

export const account = {
	get: () => me,
	loaded: () => meLoaded,
	listen(cb: MeListener) {
		meListeners.push(cb);
	},
	/** like listen(), but skips refreshes where who the user is (and what they may do) stayed the same */
	listenIdentity(cb: MeListener) {
		let last: string | null = null;
		meListeners.push(value => {
			const key = value ? `${value.id}:${value.isCreator}:${value.isAdmin}` : "";
			if (key === last) return;
			last = key;
			cb(value);
		});
	},
	/** resolves once the first /api/me answered */
	ready(): Promise<Me | null> {
		if (meLoaded) return Promise.resolve(me);
		return mePromise ?? account.refresh();
	},
	async refresh() {
		mePromise = api<Me | null>("GET", "/api/me").then(r => {
			account.set(r.success ? r.value : me);
			return me;
		});
		return mePromise;
	},
	set(value: Me | null) {
		me = value;
		meLoaded = true;
		meListeners.forEach(l => l(me));
		if (me && pollTimer === null)
			pollTimer = window.setInterval(() => account.refresh(), 60_000);
		if (!me && pollTimer !== null) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}
};

/**
 * A list of the signed-in user's things on the server (synced chats, synced cards) that tab visits ask for again
 * and again: one request at a time, and a list read in the last `freshForMs` is reused.
 * get() resolves null when the server can't be reached, [] when signed out.
 */
export function cachedList<T>(path: string, freshForMs = 30_000) {
	let listed: { at: number, userId: string, items: T[] } | null = null;
	let pending: Promise<T[] | null> | null = null;
	return {
		get(): Promise<T[] | null> {
			const me = account.get();
			if (!me) return Promise.resolve([]);
			if (listed && listed.userId === me.id && Date.now() - listed.at < freshForMs)
				return Promise.resolve(listed.items);
			pending ??= api<T[]>("GET", path).then(r => {
				pending = null;
				if (!r.success) return null;
				listed = { at: Date.now(), userId: me.id, items: r.value };
				return r.value;
			});
			return pending;
		},
		/** after an upload, download or removal, so the next get() asks the server */
		forget() {
			listed = null;
		}
	};
}

/** absolute URL of a server path, for links that leave the app (exports, OG) */
export function publicLink(path: string) {
	return new URL(path, config().publicUrl || window.location.origin).toString();
}
