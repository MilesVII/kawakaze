import type { BootPayload, Me, PublicConfig } from "@shared/api";
import type { Result } from "./types";

/*
Thin fetch wrapper for the Kawakaze backend, plus the signed-in account state.
- api(): JSON or FormData in, Result out; never throws
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
		return { success: false, error: "server can't be reached" };
	}

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
		config: { publicUrl: window.location.origin, turnstileSiteKey: "", oauth: [] }
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

/** absolute URL of a server path, for links that leave the app (exports, OG) */
export function publicLink(path: string) {
	return new URL(path, config().publicUrl || window.location.origin).toString();
}
