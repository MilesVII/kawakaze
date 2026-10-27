/*
History API routing. Paths map to tabs in units/navigation.ts.
- getRoute(): decoded path segments, `/play/abc` -> ["play", "abc"], `/` -> [""]
- navigate(): push (or replace) a path and notify listeners
- onRoute(): subscribe to any route change, including back/forward
Same-origin <a href="/..."> clicks and `[data-to]` buttons are intercepted globally.
*/

const EVENT = "kawa-route";

export function getRoute(): string[] {
	const segments = window.location.pathname
		.split("/")
		.filter(s => s)
		.map(s => decodeURIComponent(s));
	return segments.length > 0 ? segments : [""];
}

export function getQuery() {
	return new URLSearchParams(window.location.search);
}

export function navigate(to: string, replace = false) {
	const url = to.startsWith("/") ? to : `/${to}`;
	const current = window.location.pathname + window.location.search + window.location.hash;
	if (url === current) return;

	const samePath = new URL(url, window.location.origin).pathname === window.location.pathname;
	if (replace)
		history.replaceState(null, "", url);
	else
		history.pushState(null, "", url);
	if (!samePath) document.body.scrollTo({ behavior: "instant", top: 0 });
	notify();
}

export function onRoute(cb: () => void) {
	window.addEventListener(EVENT, cb);
}

function notify() {
	window.dispatchEvent(new CustomEvent(EVENT));
}

export function initRouter() {
	window.addEventListener("popstate", notify);

	document.addEventListener("click", e => {
		if (e.defaultPrevented || e.button !== 0) return;
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const target = e.target as Element | null;
		if (!target) return;

		const button = target.closest<HTMLElement>("[data-to]");
		if (button && !(button instanceof HTMLAnchorElement)) {
			e.preventDefault();
			navigate(button.dataset.to!);
			return;
		}

		const link = target.closest<HTMLAnchorElement>("a[href]");
		if (!link) return;
		if (link.target && link.target !== "_self") return;
		if (link.hasAttribute("download") || link.dataset.external !== undefined) return;
		const url = new URL(link.href, window.location.href);
		if (url.origin !== window.location.origin) return;
		// server-handled paths
		if (/^\/(api|auth|media|assets)\//.test(url.pathname)) return;
		// in-page anchors
		if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;

		e.preventDefault();
		navigate(url.pathname + url.search + url.hash);
	});
}
