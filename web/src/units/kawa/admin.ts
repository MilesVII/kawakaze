import type { AdminComment, AdminUser, DiskReport, Invite, Page, PurgeResult } from "@shared/api";
import { RampikePagination } from "@rampike/pagination";
import { account, api } from "@root/api";
import { getRoute, onRoute } from "@root/router";
import { placeholder } from "@root/utils";
import { mudcrack } from "rampike";
import { placeholderView } from "@views/common";
import { makeCommentView } from "@views/comment";
import { toast } from "@units/toasts";
import { relativeTime, userLink } from "./catalog";
import { invalidateHome } from "./home";

/* /admin: disk report, invites, users with ban/purge, recent comments */

const pages = { users: 0, comments: 0 };

export function adminUnit() {
	const refresh     = document.querySelector<HTMLButtonElement>("#admin-refresh")!;
	const inviteBtn   = document.querySelector<HTMLButtonElement>("#admin-invite-create")!;
	const usersSearch = document.querySelector<HTMLButtonElement>("#admin-users-search")!;
	const usersQuery  = document.querySelector<HTMLInputElement>("#admin-users-q")!;
	const usersPager    = document.querySelector<RampikePagination>("#admin-users-pager")!;
	const commentsPager = document.querySelector<RampikePagination>("#admin-comments-pager")!;

	refresh.addEventListener("click", loadAll);
	inviteBtn.addEventListener("click", createInvites);
	usersSearch.addEventListener("click", () => {
		pages.users = 0;
		loadUsers();
	});
	usersQuery.addEventListener("keydown", e => {
		if (e.key !== "Enter") return;
		pages.users = 0;
		loadUsers();
	});
	usersPager.addEventListener("pick", () => {
		pages.users = usersPager.page;
		loadUsers();
	});
	commentsPager.addEventListener("pick", () => {
		pages.comments = commentsPager.page;
		loadComments();
	});

	const check = async () => {
		if (getRoute()[0] !== "admin") return;
		const me = await account.ready();
		document.querySelector<HTMLElement>("#admin-denied")!.hidden = !!me?.isAdmin;
		document.querySelector<HTMLElement>("#admin-content")!.hidden = !me?.isAdmin;
		if (me?.isAdmin) loadAll();
	};
	onRoute(check);
	account.listen(check);
	check();
}

function loadAll() {
	loadDisk();
	loadInvites();
	loadUsers();
	loadComments();
}

function bytes(n: number) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		++i;
	}
	return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function loadDisk() {
	const box = document.querySelector<HTMLElement>("#admin-disk")!;
	const r = await api<DiskReport>("GET", "/api/admin/disk");
	if (!r.success) return box.replaceChildren(placeholderView(r.error));
	const d = r.value;
	const used = d.totalBytes - d.freeBytes;
	const rows: [string, string][] = [
		["disk", `${bytes(used)} used of ${bytes(d.totalBytes)} (${bytes(d.freeBytes)} free)`],
		["database", bytes(d.dbBytes)],
		["media", `${bytes(d.mediaBytes)} in ${d.mediaFiles} files`],
		["chat sync", `${bytes(d.syncBytes)} in ${d.syncItems} chats`],
		["users", `${d.users} (${d.creators} creators)`],
		["scenarios", String(d.scenarios)],
		["comments", String(d.comments)]
	];
	box.replaceChildren(...rows.flatMap(([k, v]) => [
		mudcrack({ className: "hint", contents: k }),
		mudcrack({ contents: v })
	]));
}

async function loadInvites() {
	const list = document.querySelector<HTMLElement>("#admin-invites")!;
	const r = await api<Invite[]>("GET", "/api/admin/invites");
	if (!r.success) return list.replaceChildren(placeholderView(r.error));
	list.replaceChildren(...r.value.map(inviteView));
	if (r.value.length === 0) list.append(placeholderView("No invites issued"));
}

function inviteView(i: Invite) {
	const used = !!i.usedBy;
	return mudcrack({
		className: "lineout row align-center kawa-row",
		contents: [
			mudcrack({
				className: "list grow",
				contents: [
					mudcrack({ tagName: "code", className: used ? "hint" : "", contents: i.token }),
					mudcrack({
						className: "hint",
						contents: [
							i.note || "no note",
							`issued ${relativeTime(i.createdAt)}`,
							used ? `used by ${i.usedBy!.username} ${relativeTime(i.usedAt!)}` : "unused"
						].join(" · ")
					})
				]
			}),
			used ? null : mudcrack({
				tagName: "button",
				className: "lineout no-shrink",
				contents: "copy",
				events: {
					click: () => navigator.clipboard.writeText(i.token).then(() => toast("copied"))
				}
			}),
			used ? null : mudcrack({
				tagName: "button",
				className: "lineout no-shrink",
				contents: "revoke",
				events: {
					click: async () => {
						const d = await api("DELETE", `/api/admin/invites/${encodeURIComponent(i.token)}`);
						if (!d.success) return toast(d.error);
						loadInvites();
					}
				}
			})
		]
	});
}

async function createInvites() {
	const count = parseInt(document.querySelector<HTMLInputElement>("#admin-invite-count")!.value, 10) || 1;
	const noteInput = document.querySelector<HTMLInputElement>("#admin-invite-note")!;
	const r = await api<Invite[]>("POST", "/api/admin/invites", { count, note: noteInput.value.trim() });
	if (!r.success) return toast(r.error);
	noteInput.value = "";
	toast(`${r.value.length} invite(s) issued`);
	loadInvites();
}

async function loadUsers() {
	const list  = document.querySelector<HTMLElement>("#admin-users")!;
	const pager = document.querySelector<RampikePagination>("#admin-users-pager")!;
	const q = document.querySelector<HTMLInputElement>("#admin-users-q")!.value.trim();
	const r = await api<Page<AdminUser>>("GET", `/api/admin/users?page=${pages.users}&q=${encodeURIComponent(q)}`);
	if (!r.success) return list.replaceChildren(placeholderView(r.error));
	list.replaceChildren(...r.value.items.map(userView));
	if (r.value.items.length === 0) list.append(placeholderView("No users found"));
	pager.pageCount = r.value.totalPages;
	pager.page = r.value.page;
	pager.style.display = r.value.totalPages <= 1 ? "none" : "flex";
}

function userView(u: AdminUser) {
	const flags = [
		u.isAdmin ? "admin" : null,
		u.isCreator ? "creator" : null,
		u.banned ? "BANNED" : null
	].filter(f => f).join(", ");
	const action = (caption: string, run: () => Promise<unknown>) => mudcrack({
		tagName: "button",
		className: "lineout fit",
		contents: caption,
		events: { click: run }
	});

	return mudcrack({
		className: `lineout list kawa-admin-user${u.banned ? " kawa-banned" : ""}`,
		contents: [
			mudcrack({
				className: "row-compact align-center",
				contents: [
					mudcrack({ tagName: "img", className: "avatar", attributes: { src: placeholder(u.icon), alt: "" } }),
					mudcrack({ tagName: "a", attributes: { href: userLink(u.username) }, contents: u.username }),
					mudcrack({ className: "hint", contents: flags }),
					mudcrack({ className: "hint float-end", contents: u.providers.join(", ") })
				]
			}),
			mudcrack({
				className: "hint",
				contents: [
					`${u.scenarioCount} scenarios`,
					`${u.commentCount} comments`,
					`media ${bytes(u.mediaBytes)}`,
					`sync ${bytes(u.syncBytes)}`,
					`joined ${new Date(u.createdAt).toLocaleDateString()}`,
					u.lastSeenAt ? `seen ${relativeTime(u.lastSeenAt)}` : "never seen"
				].join(" · ")
			}),
			mudcrack({
				className: "row-wrap",
				contents: [
					action(u.banned ? "unban" : "ban", async () => {
						if (!u.banned && !confirm(`ban ${u.username}? their sessions are dropped`)) return;
						const r = await api<AdminUser>("POST", `/api/admin/users/${u.id}/ban`, { banned: !u.banned });
						if (!r.success) return toast(r.error);
						loadUsers();
					}),
					action(u.isCreator ? "revoke creator" : "make creator", async () => {
						const r = await api<AdminUser>("POST", `/api/admin/users/${u.id}/creator`, { creator: !u.isCreator });
						if (!r.success) return toast(r.error);
						loadUsers();
					}),
					action("purge content", async () => {
						const typed = prompt(`Deletes all scenarios, comments and media of ${u.username}. Type the username to confirm`);
						if (typed?.trim() !== u.username) return;
						const r = await api<PurgeResult>("POST", `/api/admin/users/${u.id}/purge`);
						if (!r.success) return toast(r.error);
						toast(`purged: ${r.value.scenarios} scenarios, ${r.value.comments} comments, ${r.value.mediaFiles} media files`);
						invalidateHome();
						loadAll();
					})
				]
			})
		]
	});
}

async function loadComments() {
	const list  = document.querySelector<HTMLElement>("#admin-comments")!;
	const pager = document.querySelector<RampikePagination>("#admin-comments-pager")!;
	const r = await api<Page<AdminComment>>("GET", `/api/admin/comments?page=${pages.comments}`);
	if (!r.success) return list.replaceChildren(placeholderView(r.error));
	list.replaceChildren(...r.value.items.map(c => {
		const view = makeCommentView(c, { canVote: false, context: { title: c.scenarioTitle } }, {
			delete: async () => {
				const d = await api("DELETE", `/api/comments/${c.id}`);
				if (!d.success) return toast(d.error);
				loadComments();
			}
		});
		if (c.ipHash) view.append(mudcrack({ className: "hint", contents: `ip hash ${c.ipHash.slice(0, 12)}` }));
		return view;
	}));
	if (r.value.items.length === 0) list.append(placeholderView("No comments"));
	pager.pageCount = r.value.totalPages;
	pager.page = r.value.page;
	pager.style.display = r.value.totalPages <= 1 ? "none" : "flex";
}
