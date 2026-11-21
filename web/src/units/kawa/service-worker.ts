import { readBoot } from "@root/api";
import { toast } from "@units/toasts";

/*
Registers web/sw.js (offline use, see there) and offers a reload when a newer frontend version takes over.
Open tabs look for an update when they come back to the foreground, at most every CHECK_EVERY_MS.
*/

const CHECK_EVERY_MS = 10 * 60 * 1000;

export function serviceWorkerUnit() {
	if (!("serviceWorker" in navigator)) return;
	const own = readBoot().version;
	let offered = false;

	navigator.serviceWorker.addEventListener("message", e => {
		if (e.data?.kind !== "kawa-activated") return;
		if (!own || e.data.version === own || offered) return;
		offered = true;
		toast("Kawakaze has been updated, reload the page to get the new version", {
			actions: [
				["later", close => close()],
				["reload", () => location.reload()]
			]
		});
	});

	navigator.serviceWorker.register("/sw.js").then(registration => {
		let checkedAt = Date.now();
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState !== "visible") return;
			if (Date.now() - checkedAt < CHECK_EVERY_MS) return;
			checkedAt = Date.now();
			registration.update().catch(() => {});
		});
	}).catch(e => console.warn("service worker registration failed", e));
}
