import { account, noteReachable, onReachability } from "@root/api";
import { toast } from "@units/toasts";

/*
Tells the user when the app goes offline: the device lost its connection, or the server can't be reached (it may be
restarting for an update). Local things keep working. The state comes from the app's own requests (see api.ts) and
the browser's online/offline events; a toast shows on each change, never for the first successful request.
*/

// while offline, the server is asked again this often, so "back online" shows even when nothing else sends requests
const RETRY_MS = 15_000;

export function connectionUnit() {
	let closeOffline: (() => void) | null = null;
	let retry: number | null = null;

	onReachability(reachable => {
		if (!reachable) {
			closeOffline ??= toast(
				"You're offline. The library, chats, settings and backups still work; the catalog, sign-in and sync will be back with the connection.",
				{ actions: [["ok", close => close()]] }
			);
			retry ??= window.setInterval(() => account.refresh(), RETRY_MS);
			return;
		}
		if (retry !== null) {
			clearInterval(retry);
			retry = null;
		}
		if (!closeOffline) return;
		closeOffline();
		closeOffline = null;
		toast("Back online", { timeoutMS: 3000 });
	});

	window.addEventListener("offline", () => noteReachable(false));
	// the browser's word isn't enough: whether the server answers is what counts
	window.addEventListener("online", () => account.refresh());
	if (!navigator.onLine) noteReachable(false);
}
