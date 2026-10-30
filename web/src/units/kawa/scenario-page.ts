import type { Comment, KawaScenarioCard, Page, ScenarioMeta, Vote } from "@shared/api";
import { LIMITS } from "@shared/api";
import { RampikePagination } from "@rampike/pagination";
import { account, api, config } from "@root/api";
import { idb } from "@root/persist";
import { getRoute, navigate, onRoute } from "@root/router";
import { download, neatNumber, placeholder, renderMD, updateTitle } from "@root/utils";
import { mudcrack } from "rampike";
import { placeholderView } from "@views/common";
import { makeCommentView } from "@views/comment";
import { makeVoteView } from "@views/vote";
import { openStartModal } from "@units/library";
import { toast } from "@units/toasts";
import { relativeTime, saveToLibrary, scenarioLink, userLink } from "./catalog";
import { invalidateHome } from "./home";
import { renderTurnstile, TurnstileHandle } from "./turnstile";

/* Public scenario page: /c/:id */

type Loaded = { meta: ScenarioMeta, card: KawaScenarioCard };
let loaded: Loaded | null = null;
let commentsPage = 0;
let turnstile: TurnstileHandle | null = null;

export function scenarioPageUnit() {
	const back       = document.querySelector<HTMLButtonElement>("#sp-back")!;
	const play       = document.querySelector<HTMLButtonElement>("#sp-play")!;
	const save       = document.querySelector<HTMLButtonElement>("#sp-save")!;
	const exportBtn  = document.querySelector<HTMLButtonElement>("#sp-export")!;
	const edit       = document.querySelector<HTMLButtonElement>("#sp-edit")!;
	const body       = document.querySelector<HTMLTextAreaElement>("#sp-comment-body")!;
	const counter    = document.querySelector<HTMLElement>("#sp-comment-counter")!;
	const submit     = document.querySelector<HTMLButtonElement>("#sp-comment-submit")!;
	const pager      = document.querySelector<RampikePagination>("#sp-comments-pager")!;

	back.addEventListener("click", () => {
		if (history.length > 1) history.back();
		else navigate("/");
	});
	play.addEventListener("click", async () => {
		if (!loaded) return;
		const card = await ensureLocal(loaded.meta);
		// the page already shows the description
		if (card) openStartModal(card.id, "");
	});
	save.addEventListener("click", async () => {
		if (!loaded) return;
		const card = await ensureLocal(loaded.meta, true);
		if (card) toast("saved to your library");
	});
	exportBtn.addEventListener("click", async () => {
		if (!loaded) return;
		const r = await api<KawaScenarioCard>("GET", `/api/scenarios/${encodeURIComponent(loaded.meta.id)}?inline=1`);
		if (!r.success) {
			toast(r.error);
			return;
		}
		const filename = [r.value.card.title, r.value.chat.name].filter(t => t).join(" | ");
		download(JSON.stringify(r.value), `${filename}.aegir.scenario.json`);
	});
	edit.addEventListener("click", async () => {
		if (!loaded) return;
		const card = await ensureLocal(loaded.meta);
		if (card) navigate(`/editor/${encodeURIComponent(card.id)}`);
	});

	body.addEventListener("input", () => {
		counter.textContent = body.value.length > LIMITS.comment * .8 ? `${body.value.length}/${LIMITS.comment}` : "";
	});
	submit.addEventListener("click", postComment);
	pager.addEventListener("pick", () => {
		commentsPage = pager.page;
		loadComments();
	});

	account.listen(() => {
		if (getRoute()[0] !== "c") return;
		renderCommentForm();
		if (loaded) {
			renderHeader(loaded);
			loadComments();
		}
	});
	onRoute(() => {
		if (getRoute()[0] === "c") load();
	});
	// in-page anchor clicks (comment timestamps) bypass the router
	window.addEventListener("hashchange", () => {
		if (getRoute()[0] === "c") scrollToHash();
	});
	if (getRoute()[0] === "c") load();
}

async function load() {
	const id = getRoute()[1];
	const status  = document.querySelector<HTMLElement>("#sp-status")!;
	const content = document.querySelector<HTMLElement>("#sp-content")!;
	if (!id) return;
	if (loaded?.meta.id === id) {
		await refresh(loaded);
		return;
	}

	loaded = null;
	commentsPage = 0;
	content.hidden = true;
	status.hidden = false;
	status.textContent = "Loading...";

	const enc = encodeURIComponent(id);
	const [meta, card] = await Promise.all([
		api<ScenarioMeta>("GET", `/api/scenarios/${enc}/meta`),
		api<KawaScenarioCard>("GET", `/api/scenarios/${enc}`)
	]);
	if (getRoute()[1] !== id) return;
	if (!meta.success) {
		status.textContent = meta.error;
		return;
	}
	// owners still see their delisted cards through meta; the public card endpoint answers 410 for them
	const fullCard = card.success ? card.value : await ownCardFallback(id);
	if (!fullCard) {
		status.textContent = card.success ? "Character not found" : card.error;
		return;
	}

	loaded = { meta: meta.value, card: fullCard };
	status.hidden = true;
	content.hidden = false;
	renderHeader(loaded);
	renderCard(loaded.card);
	renderCommentForm();
	await loadComments();
	scrollToHash();
}

/**
 * Coming back to the page that is still rendered: votes and comments may have changed since,
 * and a notification link may point at a comment that wasn't there yet. The card itself is kept.
 */
async function refresh(current: Loaded) {
	const id = current.meta.id;
	if (window.location.hash.startsWith("#comment-")) commentsPage = 0;
	const [meta] = await Promise.all([
		api<ScenarioMeta>("GET", `/api/scenarios/${encodeURIComponent(id)}/meta`),
		loadComments()
	]);
	if (loaded !== current) return;
	if (meta.success) {
		current.meta = meta.value;
		renderHeader(current);
	}
	scrollToHash();
}

async function ownCardFallback(id: string) {
	const local = await idb.get("scenarios", id);
	return local.success && local.value ? local.value as KawaScenarioCard : null;
}

function renderHeader({ meta }: Loaded) {
	const me = account.get();
	updateTitle(meta.title);
	document.querySelector<HTMLImageElement>("#sp-picture")!.src = placeholder(meta.picture);
	document.querySelector<HTMLElement>("#sp-title")!.textContent = meta.title;
	document.querySelector<HTMLElement>("#sp-authors")!.replaceChildren(
		"by",
		...meta.authors.map(a => mudcrack({
			tagName: "a",
			className: "row-compact align-center kawa-author-chip",
			attributes: { href: userLink(a.username) },
			contents: [
				mudcrack({ tagName: "img", className: "avatar", attributes: { src: placeholder(a.icon), alt: "" } }),
				a.username
			]
		}))
	);
	document.querySelector<HTMLElement>("#sp-meta")!.textContent = [
		`${neatNumber(meta.tokenCount)} tokens`,
		`published ${relativeTime(meta.publishedAt)}`,
		`edited ${relativeTime(meta.updatedAt)}`
	].join(" · ");
	document.querySelector<HTMLElement>("#sp-votes")!.replaceChildren(makeVoteView(
		{ score: meta.score, myVote: meta.myVote },
		!!me,
		async value => {
			const r = await api<{ score: number, myVote: Vote }>("POST", `/api/scenarios/${encodeURIComponent(meta.id)}/vote`, { value });
			if (!r.success) {
				toast(r.error);
				return null;
			}
			meta.score = r.value.score;
			meta.myVote = r.value.myVote;
			invalidateHome();
			return r.value;
		}
	));
	document.querySelector<HTMLElement>("#sp-tags")!.replaceChildren(...meta.tags.map(tag => mudcrack({
		tagName: "a",
		attributes: { href: `/?tag=${encodeURIComponent(tag)}` },
		contents: tag
	})));
	document.querySelector<HTMLElement>("#sp-delisted")!.hidden = !meta.delisted;
	document.querySelector<HTMLElement>("#sp-edit")!.hidden = !(me && me.id === meta.ownerId);

	const fork = document.querySelector<HTMLElement>("#sp-fork")!;
	fork.hidden = !meta.parentId;
	if (meta.parentId) fork.replaceChildren(
		"Forked from ",
		mudcrack({ tagName: "a", attributes: { href: scenarioLink(meta.parentId) }, contents: "the original" })
	);
}

function renderCard(card: KawaScenarioCard) {
	document.querySelector<HTMLElement>("#sp-description")!.innerHTML = renderMD(card.card.description || "*no description*");
	document.querySelector<HTMLElement>("#sp-character-name")!.textContent = card.chat.name ? `Character name: ${card.chat.name}` : "";
	document.querySelector<HTMLElement>("#sp-definition")!.textContent = card.chat.definition;
	document.querySelector<HTMLElement>("#sp-openings")!.replaceChildren(...card.chat.initials.map((text, ix) => mudcrack({
		tagName: "details",
		className: "lineout sp-spoiler",
		contents: [
			mudcrack({ tagName: "summary", contents: `Opening message ${ix + 1}` }),
			mudcrack({ className: "sp-plain", contents: text })
		]
	})));
	const books = card.lorebooks ?? [];
	document.querySelector<HTMLElement>("#sp-lorebooks")!.textContent = books.length > 0
		? `Lorebooks: ${books.map(b => `${b.name} (${b.entries.length} entries)`).join(", ")}`
		: "";
}

function renderCommentForm() {
	const me = account.get();
	const avatar = document.querySelector<HTMLImageElement>("#sp-comment-avatar")!;
	const name   = document.querySelector<HTMLElement>("#sp-comment-name")!;
	const form   = document.querySelector<HTMLElement>("#sp-comment-form")!;
	const slot   = document.querySelector<HTMLElement>("#sp-turnstile")!;
	const submit = document.querySelector<HTMLButtonElement>("#sp-comment-submit")!;

	avatar.src = placeholder(me?.icon ?? null);
	if (me) {
		name.replaceChildren(mudcrack({ tagName: "a", attributes: { href: userLink(me.username) }, contents: me.username }));
		turnstile?.remove();
		turnstile = null;
		slot.replaceChildren();
		submit.disabled = false;
		form.hidden = false;
		return;
	}

	name.replaceChildren("anonymous ", mudcrack({
		tagName: "a",
		className: "hint",
		attributes: { href: "/profile" },
		contents: "(sign in)"
	}));
	const siteKey = config().turnstileSiteKey;
	if (!siteKey) {
		slot.replaceChildren(mudcrack({ className: "hint", contents: "Anonymous comments are disabled here. Sign in to comment." }));
		submit.disabled = true;
		return;
	}
	submit.disabled = false;
	if (!turnstile) turnstile = renderTurnstile(slot, siteKey);
}

async function postComment() {
	if (!loaded) return;
	const bodyInput = document.querySelector<HTMLTextAreaElement>("#sp-comment-body")!;
	const submit = document.querySelector<HTMLButtonElement>("#sp-comment-submit")!;
	const text = bodyInput.value.trim();
	if (!text) return;
	if (text.length > LIMITS.comment) {
		toast(`comments are limited to ${LIMITS.comment} characters`);
		return;
	}
	const payload: { body: string, turnstile?: string } = { body: text };
	if (!account.get()) {
		const token = turnstile?.token();
		if (!token) {
			toast("please complete the captcha first");
			return;
		}
		payload.turnstile = token;
	}

	submit.disabled = true;
	const r = await api<Comment>("POST", `/api/scenarios/${encodeURIComponent(loaded.meta.id)}/comments`, payload);
	submit.disabled = false;
	turnstile?.reset();
	if (!r.success) {
		toast(r.error);
		return;
	}
	bodyInput.value = "";
	commentsPage = 0;
	await loadComments();
}

async function loadComments() {
	if (!loaded) return;
	const id = loaded.meta.id;
	const list  = document.querySelector<HTMLElement>("#sp-comments")!;
	const total = document.querySelector<HTMLElement>("#sp-comment-total")!;
	const pager = document.querySelector<RampikePagination>("#sp-comments-pager")!;

	const r = await api<Page<Comment>>("GET", `/api/scenarios/${encodeURIComponent(id)}/comments?page=${commentsPage}`);
	if (loaded?.meta.id !== id) return;
	if (!r.success) {
		list.replaceChildren(placeholderView(r.error));
		return;
	}
	total.textContent = r.value.totalItems ? String(r.value.totalItems) : "";
	const me = account.get();
	list.replaceChildren(...r.value.items.map(c => makeCommentView(c, { canVote: !!me }, {
		vote: async value => {
			const v = await api<{ score: number, myVote: Vote }>("POST", `/api/comments/${c.id}/vote`, { value });
			if (!v.success) {
				toast(v.error);
				return null;
			}
			return v.value;
		},
		reply: () => {
			if (!c.author) return;
			const input = document.querySelector<HTMLTextAreaElement>("#sp-comment-body")!;
			const mention = `@${c.author.username} `;
			if (!input.value.includes(mention)) input.value = mention + input.value;
			input.focus();
			input.scrollIntoView({ behavior: "smooth", block: "center" });
		},
		delete: async () => {
			if (!confirm("delete this comment?")) return;
			const d = await api("DELETE", `/api/comments/${c.id}`);
			if (!d.success) toast(d.error);
			else loadComments();
		}
	})));
	if (r.value.items.length === 0) list.append(mudcrack({ className: "hint", contents: "No comments yet" }));
	pager.pageCount = r.value.totalPages;
	pager.page = r.value.page;
	pager.style.display = r.value.totalPages <= 1 ? "none" : "flex";
}

function scrollToHash() {
	const hash = window.location.hash;
	if (!hash.startsWith("#comment-")) return;
	document.querySelectorAll(".kawa-highlight").forEach(e => e.classList.remove("kawa-highlight"));
	const target = document.querySelector(hash);
	if (target) {
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		target.classList.add("kawa-highlight");
	}
}

/** card in the local library, downloaded or refreshed from the server when needed */
async function ensureLocal(meta: ScenarioMeta, forceRefresh = false) {
	const existing = await idb.get("scenarios", meta.id);
	const local = existing.success ? existing.value : undefined;
	if (local && !forceRefresh && local.lastUpdate >= meta.updatedAt) return local;
	if (local && local.lastUpdate > meta.updatedAt && forceRefresh) {
		if (!confirm("Your local copy has changes newer than the published version. Replace it?")) return local;
	}
	const r = await saveToLibrary(meta.id);
	if (!r.success) {
		if (local) return local;
		toast(r.error);
		return null;
	}
	return r.value;
}
