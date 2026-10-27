import type { CommentWithScenario, Me, Notification, Page, ScenarioMeta, SessionInfo } from "@shared/api";
import { LIMITS, USERNAME_RE } from "@shared/api";
import { RampikeImagePicker } from "@rampike/imagepicker";
import { RampikePagination } from "@rampike/pagination";
import { RampikeTabs } from "@rampike/tabs";
import { account, api, config } from "@root/api";
import { optimizeToWEBP } from "@root/optimizer";
import { idb } from "@root/persist";
import { getQuery, getRoute, navigate, onRoute } from "@root/router";
import { placeholder, renderMD } from "@root/utils";
import { mudcrack } from "rampike";
import { placeholderView } from "@views/common";
import { makeCommentView } from "@views/comment";
import { toast } from "@units/toasts";
import { parseTags, relativeTime, saveToLibrary, scenarioLink, userLink } from "./catalog";
import { forgetUserPage } from "./user-page";

/* /profile: sign-in for guests, five tabs for signed-in users */

const PROVIDER_NAMES = { github: "GitHub", google: "Google" } as const;
const pages = { comments: 0, notifications: 0 };

export function profileUnit() {
	const tabs        = document.querySelector<RampikeTabs>("#profile-tabs")!;
	const signout     = document.querySelector<HTMLButtonElement>("#profile-signout")!;
	const save        = document.querySelector<HTMLButtonElement>("#profile-save")!;
	const iconPicker  = document.querySelector<RampikeImagePicker>("#profile-icon")!;
	const iconRemove  = document.querySelector<HTMLButtonElement>("#profile-icon-remove")!;
	const bioPreview  = document.querySelector<HTMLButtonElement>("#profile-bio-preview")!;
	const redeem      = document.querySelector<HTMLButtonElement>("#profile-invite-submit")!;
	const readAll     = document.querySelector<HTMLButtonElement>("#profile-notifications-read")!;
	const deleteAcc   = document.querySelector<HTMLButtonElement>("#profile-delete-account")!;
	const commentsPager      = document.querySelector<RampikePagination>("#profile-comments-pager")!;
	const notificationsPager = document.querySelector<RampikePagination>("#profile-notifications-pager")!;

	renderProviders();

	signout.addEventListener("click", async () => {
		await api("POST", "/api/auth/signout");
		account.set(null);
		toast("signed out");
	});
	save.addEventListener("click", saveProfile);
	iconPicker.input.addEventListener("input", uploadIcon);
	iconRemove.addEventListener("click", async () => {
		const r = await api<Me>("DELETE", "/api/me/icon");
		if (!r.success) return toast(r.error);
		account.set(r.value);
	});
	bioPreview.addEventListener("click", () => {
		const container = document.querySelector<HTMLElement>("#profile-bio-preview-container")!;
		const bio = document.querySelector<HTMLTextAreaElement>("#profile-bio")!;
		container.hidden = !container.hidden;
		container.innerHTML = renderMD(bio.value);
	});
	redeem.addEventListener("click", redeemInvite);
	readAll.addEventListener("click", async () => {
		await api("POST", "/api/me/notifications/read", {});
		await account.refresh();
		loadNotifications();
	});
	deleteAcc.addEventListener("click", deleteAccount);
	commentsPager.addEventListener("pick", () => {
		pages.comments = commentsPager.page;
		loadComments();
	});
	notificationsPager.addEventListener("pick", () => {
		pages.notifications = notificationsPager.page;
		loadNotifications();
	});

	// load tab contents lazily, when they're picked
	new MutationObserver(() => {
		if (getRoute()[0] === "profile") loadTab(tabs.tab);
	}).observe(tabs, { attributes: true, attributeFilter: ["tab"] });

	let shownFor: string | null = null;
	account.listen(me => {
		render(me);
		if (me && shownFor !== me.id && getRoute()[0] === "profile") loadTab(tabs.tab);
		shownFor = me?.id ?? null;
	});
	onRoute(() => {
		if (getRoute()[0] !== "profile") return;
		showError();
		if (account.get()) {
			account.refresh();
			loadTab(tabs.tab);
		}
	});
	if (getRoute()[0] === "profile") showError();
}

function renderProviders() {
	const list = document.querySelector<HTMLElement>("#profile-providers")!;
	const providers = config().oauth;
	if (providers.length === 0) {
		list.replaceChildren(placeholderView("Sign-in is not configured on this server"));
		return;
	}
	list.replaceChildren(...providers.map(p => mudcrack({
		tagName: "a",
		className: "lineout center-text pointer kawa-signin",
		attributes: { href: `/auth/${p}?next=${encodeURIComponent("/profile")}` },
		contents: `Sign in with ${PROVIDER_NAMES[p]}`
	})));
}

function showError() {
	const error = getQuery().get("error");
	const box = document.querySelector<HTMLElement>("#profile-error")!;
	box.hidden = !error;
	box.textContent = error === "banned"
		? "This account is banned"
		: "Sign-in failed, please try again";
	if (error) history.replaceState(null, "", "/profile");
}

function render(me: Me | null) {
	document.querySelector<HTMLElement>("#profile-signed-out")!.hidden = !!me || !account.loaded();
	document.querySelector<HTMLElement>("#profile-signed-in")!.hidden = !me;
	document.querySelector<HTMLElement>("#profile-signout")!.hidden = !me;
	const publicLink = document.querySelector<HTMLAnchorElement>("#profile-public-link")!;
	publicLink.hidden = !me;
	if (!me) return;

	publicLink.href = userLink(me.username);
	const icon = document.querySelector<RampikeImagePicker>("#profile-icon")!;
	if (me.icon) icon.value = me.icon;
	else icon.usePlaceholder();
	document.querySelector<HTMLButtonElement>("#profile-icon-remove")!.hidden = !me.icon;
	document.querySelector<HTMLInputElement>("#profile-username")!.value = me.username;
	document.querySelector<HTMLTextAreaElement>("#profile-bio")!.value = me.bio;
	document.querySelector<HTMLTextAreaElement>("#profile-hidden-tags")!.value = me.hiddenTags.join(", ");
	document.querySelector<HTMLElement>("#profile-unread")!.textContent = me.unread ? `(${me.unread})` : "";
	document.querySelector<HTMLElement>("#profile-creator")!.hidden = !me.isCreator;
	document.querySelector<HTMLElement>("#profile-invite")!.hidden = me.isCreator;
}

function loadTab(tab: string) {
	if (!account.get()) return;
	if (tab === "comments") loadComments();
	if (tab === "characters") loadCharacters();
	if (tab === "notifications") loadNotifications();
	if (tab === "sessions") loadSessions();
}

async function saveProfile() {
	const username = document.querySelector<HTMLInputElement>("#profile-username")!.value.trim();
	const bio = document.querySelector<HTMLTextAreaElement>("#profile-bio")!.value;
	const hiddenTags = parseTags(document.querySelector<HTMLTextAreaElement>("#profile-hidden-tags")!.value);
	if (!USERNAME_RE.test(username)) return toast("username: 3 to 24 latin letters, digits, _ or -");
	if (bio.length > LIMITS.bio) return toast(`bio is limited to ${LIMITS.bio} characters`);

	const r = await api<Me>("PATCH", "/api/me", { username, bio, hiddenTags });
	if (!r.success) return toast(r.error);
	forgetUserPage();
	account.set(r.value);
	toast("profile saved");
}

async function uploadIcon() {
	const picker = document.querySelector<RampikeImagePicker>("#profile-icon")!;
	const file = picker.file;
	if (!file) return;
	const [optimized] = await optimizeToWEBP(file);
	const form = new FormData();
	form.append("icon", optimized, "icon.webp");
	const r = await api<Me>("PUT", "/api/me/icon", form);
	if (!r.success) {
		toast(r.error);
		render(account.get());
		return;
	}
	forgetUserPage();
	account.set(r.value);
	toast("icon updated");
}

async function redeemInvite() {
	const token = document.querySelector<HTMLInputElement>("#profile-invite-token")!.value.trim();
	const accepted = document.querySelector<HTMLInputElement>("#profile-invite-terms")!.checked;
	if (!accepted) return toast("please accept the terms first");
	if (!token) return toast("enter your invite token");
	const r = await api<Me>("POST", "/api/me/redeem", { token, acceptTerms: true });
	if (!r.success) return toast(r.error);
	account.set(r.value);
	toast("you're a creator now! publish characters from the editor in your library");
	loadCharacters();
}

async function loadComments() {
	const list  = document.querySelector<HTMLElement>("#profile-comments")!;
	const pager = document.querySelector<RampikePagination>("#profile-comments-pager")!;
	const r = await api<Page<CommentWithScenario>>("GET", `/api/me/comments?page=${pages.comments}`);
	if (!r.success) return list.replaceChildren(placeholderView(r.error));

	list.replaceChildren(...r.value.items.map(c => makeCommentView(c, { canVote: false, context: { title: c.scenarioTitle } }, {
		delete: async () => {
			if (!confirm("delete this comment?")) return;
			const d = await api("DELETE", `/api/comments/${c.id}`);
			if (!d.success) toast(d.error);
			else loadComments();
		}
	})));
	if (r.value.items.length === 0) list.append(placeholderView("You haven't commented yet"));
	setPager(pager, r.value);
}

async function loadCharacters() {
	const me = account.get();
	if (!me?.isCreator) return;
	const list = document.querySelector<HTMLElement>("#profile-characters")!;
	const r = await api<ScenarioMeta[]>("GET", "/api/me/scenarios");
	if (!r.success) return list.replaceChildren(placeholderView(r.error));

	list.replaceChildren(...r.value.map(s => mudcrack({
		className: "lineout row align-center kawa-row",
		contents: [
			mudcrack({ tagName: "img", className: "avatar-big", attributes: { src: placeholder(s.picture), alt: "" } }),
			mudcrack({
				className: "list grow",
				contents: [
					mudcrack({ tagName: "a", attributes: { href: scenarioLink(s.id) }, contents: s.title }),
					mudcrack({
						className: "hint",
						contents: [
							s.delisted ? "delisted" : `▲ ${s.score}`,
							`${s.commentCount} comments`,
							`edited ${relativeTime(s.updatedAt)}`
						].join(" · ")
					})
				]
			}),
			mudcrack({
				tagName: "button",
				className: "lineout no-shrink",
				contents: "open in editor",
				events: { click: () => openInEditor(s) }
			})
		]
	})));
	if (r.value.length === 0) list.append(placeholderView("Nothing published yet. Create a scenario in your library and hit publish in the editor"));
}

async function openInEditor(s: ScenarioMeta) {
	const local = await idb.get("scenarios", s.id);
	if (!local.success || !local.value) {
		const r = await saveToLibrary(s.id);
		if (!r.success) return toast(r.error);
	} else if (local.value.lastUpdate < s.updatedAt) {
		if (confirm("The published version is newer than your local copy. Load it into the library first?")) {
			const r = await saveToLibrary(s.id);
			if (!r.success) return toast(r.error);
		}
	}
	navigate(`/editor/${encodeURIComponent(s.id)}`);
}

async function loadNotifications() {
	const list  = document.querySelector<HTMLElement>("#profile-notifications")!;
	const pager = document.querySelector<RampikePagination>("#profile-notifications-pager")!;
	const r = await api<Page<Notification>>("GET", `/api/me/notifications?page=${pages.notifications}`);
	if (!r.success) return list.replaceChildren(placeholderView(r.error));

	list.replaceChildren(...r.value.items.map(n => {
		const link = `${scenarioLink(n.scenario.id)}#comment-${n.comment.id}`;
		const who = n.actor?.username ?? "someone anonymous";
		const what = n.kind === "mention" ? "mentioned you on" : "commented on";
		return mudcrack({
			className: `lineout list kawa-notification${n.read ? "" : " kawa-unread"}`,
			contents: [
				mudcrack({
					className: "row-compact align-center",
					contents: [
						mudcrack({ tagName: "img", className: "avatar", attributes: { src: placeholder(n.actor?.icon ?? null), alt: "" } }),
						mudcrack({
							contents: [
								n.actor ? mudcrack({ tagName: "a", attributes: { href: userLink(n.actor.username) }, contents: who }) : who,
								` ${what} `,
								mudcrack({ tagName: "a", attributes: { href: link }, contents: n.scenario.title })
							]
						}),
						mudcrack({ className: "hint float-end no-shrink", contents: relativeTime(n.createdAt) })
					]
				}),
				mudcrack({
					tagName: "a",
					className: "kawa-notification-body",
					attributes: { href: link },
					contents: n.comment.body.length > 280 ? `${n.comment.body.slice(0, 280)}…` : n.comment.body
				})
			]
		});
	}));
	if (r.value.items.length === 0) list.append(placeholderView("No notifications"));
	setPager(pager, r.value);

	const unread = r.value.items.filter(n => !n.read).map(n => n.id);
	if (unread.length > 0) {
		await api("POST", "/api/me/notifications/read", { ids: unread });
		account.refresh();
	}
}

async function loadSessions() {
	const list = document.querySelector<HTMLElement>("#profile-sessions")!;
	const r = await api<SessionInfo[]>("GET", "/api/me/sessions");
	if (!r.success) return list.replaceChildren(placeholderView(r.error));

	list.replaceChildren(...r.value.map(s => mudcrack({
		className: "lineout row align-center kawa-row",
		contents: [
			mudcrack({
				className: "list grow",
				contents: [
					mudcrack({ contents: describeAgent(s.userAgent) + (s.current ? " (this device)" : "") }),
					mudcrack({
						className: "hint",
						contents: `signed in ${new Date(s.createdAt).toLocaleString()}, last seen ${relativeTime(s.lastSeenAt)}`
					})
				]
			}),
			mudcrack({
				tagName: "button",
				className: "lineout no-shrink",
				contents: s.current ? "sign out" : "revoke",
				events: {
					click: async () => {
						const d = await api("DELETE", `/api/me/sessions/${encodeURIComponent(s.id)}`);
						if (!d.success) return toast(d.error);
						if (s.current) account.set(null);
						else loadSessions();
					}
				}
			})
		]
	})));
}

function describeAgent(ua: string) {
	if (!ua) return "unknown device";
	const browser = /Firefox\//.test(ua) ? "Firefox"
		: /Edg\//.test(ua) ? "Edge"
		: /Chrome\//.test(ua) ? "Chrome"
		: /Safari\//.test(ua) ? "Safari"
		: "browser";
	const os = /Android/.test(ua) ? "Android"
		: /iPhone|iPad/.test(ua) ? "iOS"
		: /Windows/.test(ua) ? "Windows"
		: /Mac OS/.test(ua) ? "macOS"
		: /Linux/.test(ua) ? "Linux"
		: "";
	return [browser, os].filter(t => t).join(" on ");
}

async function deleteAccount() {
	const me = account.get();
	if (!me) return;
	const typed = prompt(`This deletes your account, published characters, comments and synced chats.\nType your username (${me.username}) to confirm`);
	if (typed === null) return;
	if (typed.trim() !== me.username) return toast("username doesn't match");
	const r = await api("DELETE", "/api/me", { confirm: me.username });
	if (!r.success) return toast(r.error);
	account.set(null);
	toast("account deleted");
	navigate("/");
}

function setPager(pager: RampikePagination, page: Page<unknown>) {
	pager.pageCount = page.totalPages;
	pager.page = page.page;
	pager.style.display = page.totalPages <= 1 ? "none" : "flex";
}
