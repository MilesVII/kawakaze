import { RampikeTabs } from "@rampike/tabs";
import { account } from "@root/api";
import { getRoute, initRouter, onRoute } from "@root/router";
import { updateTitle } from "@root/utils";

const ROUTE_TABS: Record<string, string> = {
	"":       "home",
	library:  "library",
	chats:    "chats",
	settings: "settings",
	profile:  "profile",
	admin:    "admin",
	editor:   "scenario-editor",
	play:     "play",
	c:        "scenario-page",
	u:        "user-page",
	terms:    "terms"
};
/** tabs that set their own title */
const SELF_TITLED = new Set(["play", "scenario-page", "user-page"]);
const TITLES: Record<string, string> = {
	library: "Library",
	chats: "Chats",
	settings: "Settings",
	profile: "Profile",
	admin: "Admin",
	"scenario-editor": "Editor",
	terms: "Terms of use"
};

export function currentTab() {
	return ROUTE_TABS[getRoute()[0]] ?? "notfound";
}

export function navigationUnit() {
	initRouter();
	const tabs = document.querySelector<RampikeTabs>("ram-tabs#tabs-main")!;
	const navLinks = document.querySelectorAll<HTMLAnchorElement>("#nav a[data-nav]");
	const unread = document.querySelector<HTMLElement>("#nav-unread")!;
	const adminLink = document.querySelector<HTMLElement>("#nav-admin")!;

	function update() {
		const tab = currentTab();
		tabs.tab = tab;
		document.body.dataset.route = tab;
		const section = tab === "scenario-editor" ? "library" : tab;
		navLinks.forEach(a => {
			if (a.dataset.nav === section) a.setAttribute("aria-current", "page");
			else a.removeAttribute("aria-current");
		});
		if (!SELF_TITLED.has(tab)) updateTitle(TITLES[tab] ?? null);
	}

	onRoute(update);
	update();

	account.listen(me => {
		unread.hidden = !me?.unread;
		unread.textContent = me?.unread ? String(Math.min(me.unread, 99)) : "";
		adminLink.hidden = !me?.isAdmin;
	});
}
