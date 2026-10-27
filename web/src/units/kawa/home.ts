import type { Page, ScenarioListItem, ScenarioSort, SearchField, SiteStats } from "@shared/api";
import { RampikePagination } from "@rampike/pagination";
import { api, readBoot, takeBootHome } from "@root/api";
import { mudcrack } from "rampike";
import { getQuery, getRoute, navigate, onRoute } from "@root/router";
import { placeholderView } from "@views/common";
import { makeKawaCardView } from "@views/kawa-card";
import { onHiddenTagsChange } from "./catalog";

/*
Homepage catalog. Query state lives in the URL (?q=&sort=&page=&tag=&fields=) so back/forward and links work.
The first page of the default query arrives inlined in the shell.
*/

const DEFAULT_FIELDS: SearchField[] = ["title", "description", "tags", "character", "authors"];
const SORTS: ScenarioSort[] = ["updated", "published", "score"];

type HomeQuery = {
	q: string,
	sort: ScenarioSort,
	page: number,
	tag: string,
	fields: SearchField[]
};

let lastKey: string | null = null;
let lastPage: Page<ScenarioListItem> | null = null;
let stats: SiteStats | null = null;

export function homeUnit() {
	const sort         = document.querySelector<HTMLSelectElement>("#home-sort")!;
	const input        = document.querySelector<HTMLInputElement>("#home-search-input")!;
	const searchButton = document.querySelector<HTMLButtonElement>("#home-search-button")!;
	const optionsButton= document.querySelector<HTMLButtonElement>("#home-search-options")!;
	const fieldsBox    = document.querySelector<HTMLElement>("#home-search-fields")!;
	const tagClear     = document.querySelector<HTMLButtonElement>("#home-tag-clear")!;
	const pager        = document.querySelector<RampikePagination>("#home-pager")!;
	const fieldBoxes   = Array.from(fieldsBox.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));

	const bootHome = takeBootHome();
	if (bootHome && isDefault(readQuery())) {
		lastKey = queryKey(readQuery());
		lastPage = bootHome;
	}
	stats = readBoot().stats ?? null;

	function push(patch: Partial<HomeQuery>) {
		const next = { ...readQuery(), ...patch };
		navigate(`/${queryString(next)}`);
	}
	function search() {
		push({
			q: input.value.trim(),
			page: 0,
			fields: fieldBoxes.filter(b => b.checked).map(b => b.value as SearchField)
		});
	}

	sort.addEventListener("change", () => push({ sort: sort.value as ScenarioSort, page: 0 }));
	searchButton.addEventListener("click", search);
	input.addEventListener("keydown", e => {
		if (e.key === "Enter") search();
	});
	optionsButton.addEventListener("click", () => fieldsBox.hidden = !fieldsBox.hidden);
	tagClear.addEventListener("click", () => push({ tag: "", page: 0 }));
	pager.addEventListener("pick", () => push({ page: pager.page }));

	onRoute(() => {
		if (getRoute()[0] === "") update();
	});
	onHiddenTagsChange(() => {
		if (getRoute()[0] === "" && lastPage) render(lastPage);
	});
	if (getRoute()[0] === "") update();

	function syncControls(query: HomeQuery) {
		sort.value = query.sort;
		input.value = query.q;
		fieldBoxes.forEach(b => b.checked = query.fields.includes(b.value as SearchField));
		const tagRow = document.querySelector<HTMLElement>("#home-tag")!;
		tagRow.hidden = !query.tag;
		document.querySelector<HTMLElement>("#home-tag-name")!.textContent = query.tag;
	}

	async function updateStats() {
		const box = document.querySelector<HTMLElement>("#home-stats")!;
		if (!stats) {
			const r = await api<SiteStats>("GET", "/api/scenarios/stats");
			if (!r.success) return;
			stats = r.value;
		}
		const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
		box.replaceChildren(...[
			plural(stats.scenarios, "character"),
			plural(stats.creators, "creator"),
			plural(stats.comments, "comment")
		].map(text => mudcrack({ tagName: "span", contents: text })));
	}

	async function update() {
		const query = readQuery();
		syncControls(query);
		updateStats();
		const key = queryKey(query);
		if (key === lastKey && lastPage) {
			render(lastPage);
			return;
		}

		const list = document.querySelector<HTMLElement>("#home-cards")!;
		if (!lastPage) list.replaceChildren(placeholderView("Loading..."));

		const r = await api<Page<ScenarioListItem>>("GET", `/api/scenarios${queryString(query)}`);
		if (queryKey(readQuery()) !== key) return; // navigated away meanwhile
		if (!r.success) {
			list.replaceChildren(placeholderView(`Can't load characters: ${r.error}`));
			return;
		}
		lastKey = key;
		lastPage = r.value;
		render(r.value);
	}

	function render(page: Page<ScenarioListItem>) {
		const list = document.querySelector<HTMLElement>("#home-cards")!;
		const cards = page.items.map(item => makeKawaCardView(item, {
			tag: tag => push({ tag, page: 0, q: "" })
		}));
		list.replaceChildren(...cards);
		if (cards.length === 0) list.append(placeholderView("No characters found"));

		pager.pageCount = page.totalPages;
		pager.page = Math.min(page.page, Math.max(page.totalPages - 1, 0));
		pager.style.display = page.totalPages <= 1 ? "none" : "flex";
	}
}

function readQuery(): HomeQuery {
	const p = getQuery();
	const sort = p.get("sort") as ScenarioSort;
	const fields = (p.get("fields") ?? "").split(",").filter(f => f) as SearchField[];
	const page = parseInt(p.get("page") ?? "0", 10);
	return {
		q: p.get("q") ?? "",
		sort: SORTS.includes(sort) ? sort : "updated",
		page: isNaN(page) || page < 0 ? 0 : page,
		tag: p.get("tag") ?? "",
		fields: fields.length > 0 ? fields : DEFAULT_FIELDS
	};
}

function queryString(query: HomeQuery) {
	const p = new URLSearchParams();
	if (query.q) p.set("q", query.q);
	if (query.sort !== "updated") p.set("sort", query.sort);
	if (query.page) p.set("page", String(query.page));
	if (query.tag) p.set("tag", query.tag);
	const fields = [...query.fields].sort().join(",");
	if (query.q && fields !== [...DEFAULT_FIELDS].sort().join(",")) p.set("fields", query.fields.join(","));
	const s = p.toString();
	return s ? `?${s}` : "";
}
function queryKey(query: HomeQuery) {
	return queryString(query);
}
function isDefault(query: HomeQuery) {
	return queryString(query) === "";
}

/** forget the cached page, e.g. after publishing, so the next visit refetches */
export function invalidateHome() {
	lastKey = null;
	stats = null;
}
