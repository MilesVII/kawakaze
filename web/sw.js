/*
Service worker: keeps the app usable offline and during server restarts.
- Pages: network first, the cached shell when the network fails or the server answers 5xx. The app routes on the
  client, so one shell serves every path.
- /assets/ with ?v=<hash>: from the cache, since the URL changes with the content.
- Other /assets/ and the favicon: network first (cheap revalidation), the cache when offline.
- /api/, /auth/ and /media/ are left to the browser.
The server prepends `const MANIFEST = { version, precache }`, see server/src/assets.ts. A new version installs at
once, drops the older caches and tells open pages, which offer to reload.
*/

const CACHE = `kawa-${MANIFEST.version}`;
const SHELL = "/__shell";

self.addEventListener("install", event => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE);
		await cache.addAll(MANIFEST.precache.map(url => new Request(url, { cache: "no-cache" })));
		const shell = await fetch("/", { cache: "no-cache" });
		if (!shell.ok) throw new Error(`shell: ${shell.status}`);
		await cache.put(SHELL, shell);
		await self.skipWaiting();
	})());
});

self.addEventListener("activate", event => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(names.filter(n => n.startsWith("kawa-") && n !== CACHE).map(n => caches.delete(n)));
		await self.clients.claim();
		const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		for (const page of pages) page.postMessage({ kind: "kawa-activated", version: MANIFEST.version });
	})());
});

self.addEventListener("fetch", event => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (/^\/(api|auth|media)\//.test(url.pathname)) return;

	if (request.mode === "navigate") {
		event.respondWith(page(request));
	} else if (url.pathname.startsWith("/assets/") && url.searchParams.has("v")) {
		event.respondWith(cacheFirst(request));
	} else if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.png") {
		event.respondWith(networkFirst(request));
	}
});

async function page(request) {
	try {
		const response = await fetch(request);
		if (response.status < 500) return response;
		return (await caches.match(SHELL)) ?? response;
	} catch (e) {
		const shell = await caches.match(SHELL);
		if (shell) return shell;
		throw e;
	}
}

async function cacheFirst(request) {
	const cached = await caches.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) await keep(request, response.clone());
	return response;
}

async function networkFirst(request) {
	try {
		const response = await fetch(request);
		if (response.ok) await keep(request, response.clone());
		return response;
	} catch (e) {
		const cached = await caches.match(request);
		if (cached) return cached;
		throw e;
	}
}

async function keep(request, response) {
	const cache = await caches.open(CACHE);
	await cache.put(request, response);
}
