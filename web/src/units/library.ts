import { getBlobLink, idb, listen } from "@root/persist";
import { renderMD, setSelectOptions } from "@root/utils";
import { getRoute, navigate, onRoute } from "@root/router";
import { account } from "@root/api";
import { mudcrack } from "rampike";
import type { CardSyncHandle, ScenarioLookup } from "@shared/api";
import { lookupScenarios, onTagLabels, peekLookup, saveToLibrary, scenarioLink } from "./kawa/catalog";
import { placeholderView } from "@views/common";
import { makeScenarioCardView } from "@views/scenario-card";
import { makeSyncedCardView } from "@views/synced-card";
import { RampikeModal } from "@rampike/modal";
import { start } from "./chat/start";
import { ScenarioCard } from "@root/types";
import { RampikeFilePicker } from "@rampike/filepicker";
import { importSTMessages } from "./library/st";
import { toast } from "./toasts";
import { downloadScenario, importScenario } from "./library/files";
import { discardSyncedCard, downloadSyncedCard, listSyncedCards, uploadCard } from "./library/card-sync";
import { RampikePagination } from "@rampike/pagination";
import { filterBySearch } from "./library/search";
import { hashListenerUnit } from "./library/hash";
import { datacatBrowserUnit } from "./library/datacat-browser";

const CARDS_PER_PAGE = 16;
let openerRelay: {
	scenarioId: string
} | null = null;

export function libraryUnit() {
	hashListenerUnit();
	datacatBrowserUnit();

	const startButton        = document.querySelector<HTMLButtonElement>("#library-start-button")!;
	const startPersonaPicker = document.querySelector<HTMLSelectElement>("#library-start-persona")!;
	const startImportButton  = document.querySelector<RampikeFilePicker>("#library-start-import")!;
	const importButton       = document.querySelector<RampikeFilePicker>("#library-import")!;
	const pager              = document.querySelector<RampikePagination>("#library-pager")!;
	const modal              = document.querySelector<RampikeModal>("#library-start")!;
	const search = {
		open: document.querySelector<HTMLButtonElement>("#library-search")!,
		button: document.querySelector<HTMLButtonElement>("#library-search-button")!,
		cancel: document.querySelector<HTMLButtonElement>("#library-search-cancel")!,
		dialog: document.querySelector<HTMLElement>("#library-search-dialog")!
	}

	startButton.addEventListener("click", async () => {
		if (!openerRelay) return;
		const personaId = startPersonaPicker.value;
		if (!personaId) return;
		await start(personaId, openerRelay.scenarioId);
		modal.close();
	});
	startImportButton.addEventListener("input", async () => {
		const file = startImportButton.input.files?.[0];
		if (!file) return;
		const personaId = startPersonaPicker.value;
		if (!personaId) return;
		if (!openerRelay) return;

		const messages = await importSTMessages(file);
		if (messages.length === 0) return;

		await start(personaId, openerRelay.scenarioId, messages);
		modal.close();
	});

	importButton.addEventListener("input", () => {
		const files = importButton.input.files;
		if (!files?.[0]) return;

		for (let i = 0; i < files.length; ++i) {
			importScenario(files.item(i)!);
		}
	});

	search.open.addEventListener("click", () => {
		search.dialog.hidden = false;
	});
	search.button.addEventListener("click", () => {
		pager.page = 0;
		search.dialog.dataset.active = "true";
		update();
	});
	search.cancel.addEventListener("click", () => {
		search.dialog.hidden = true;
		search.dialog.removeAttribute("data-active");
		update();
	});

	pager.addEventListener("pick", update);
	account.listenIdentity(me => {
		if (!me) synced = [];
		update();
		if (me) refreshSynced();
	});
	onRoute(() => {
		if (getRoute()[0] === "library") refreshSynced();
	});
	listen(async u => {
		if (u.storage !== "idb") return;
		if (u.store !== "scenarios") return;

		update();
	});
	onTagLabels(update);
	update();
}

/** cards waiting on the server, shown above the library; fetched on visits, not on every update */
let synced: CardSyncHandle[] = [];
async function refreshSynced() {
	synced = await listSyncedCards();
	update();
}

let updateSequence = 0;
async function update() {
	const list = document.querySelector<HTMLElement>("#library-cards")!;
	const pager = document.querySelector<RampikePagination>("#library-pager")!;

	// updates overlap (storage events, account changes, pager): only the latest one may touch the list
	const run = ++updateSequence;
	list.innerHTML = "";
	const items = await idb.getAll("scenarios");
	if (!items.success || run !== updateSequence) return;

	updateSynced(items.value);
	items.value = filterBySearch(items.value);

	pager.pageCount = Math.ceil(items.value.length / CARDS_PER_PAGE);
	pager.style.display = pager.pageCount <= 1 ? "none" : "flex";
	if (pager.page >= pager.pageCount) pager.page = pager.pageCount - 1;
	if (pager.pageCount > 0 && pager.page < 0) pager.page = 0;

	const ix0 = pager.page * CARDS_PER_PAGE;
	const ix1 = ix0 + CARDS_PER_PAGE;
	const pageItems = items.value.reverse().slice(ix0, ix1);
	const contents = pageItems.map(scenarioCardView);

	list.append(...contents);
	if (contents.length === 0)
		list.append(placeholderView("No scenario cards found"));

	// known statuses render right away; only cards the cache hasn't seen are looked up
	const unknown: string[] = [];
	pageItems.forEach((item, ix) => {
		const known = peekLookup(item.id);
		if (known === undefined) unknown.push(item.id);
		else if (known) showPublishedStatus(contents[ix], item, known);
	});
	if (unknown.length === 0) return;

	const published = await lookupScenarios(unknown);
	if (run !== updateSequence) return;
	pageItems.forEach((item, ix) => {
		const remote = published.get(item.id);
		if (remote) showPublishedStatus(contents[ix], item, remote);
	});
}

function showPublishedStatus(view: Element, item: ScenarioCard, remote: ScenarioLookup) {
	const status = view.querySelector<HTMLElement>("[data-ref='status']");
	if (!status) return;
	const mine = account.get()?.id === remote.ownerId;
	const outdated = remote.updatedAt > item.lastUpdate;
	const parts: (string | Node)[] = [
		mudcrack({ tagName: "a", attributes: { href: scenarioLink(item.id) }, contents: "published" })
	];
	if (mine) parts.push(" · yours");
	if (remote.delisted) parts.push(" · delisted");
	if (mine && item.lastUpdate > remote.updatedAt) parts.push(" · unpublished changes");
	if (outdated) parts.push(" · ", mudcrack({
		tagName: "button",
		className: "strip ghost pointer kawa-accent",
		contents: "update available",
		events: {
			click: async () => {
				const r = await saveToLibrary(item.id);
				if (!r.success) toast(r.error);
				else toast("updated");
			}
		}
	}));
	status.replaceChildren(...parts);
	status.hidden = false;
}

function scenarioCardView(item: ScenarioCard) {
	return makeScenarioCardView(
		item,
		item.card.picture ? getBlobLink(item.card.picture) : null,
		{
			play:     () => openStartModal(item.id, item.card.description),
			download: () => downloadScenario(item),
			delete:   () => deleteScenario(item.id, item.card.title),
			edit:     () => navigate(`/editor/${encodeURIComponent(item.id)}`),
			sync:     account.get() ? async () => { if (await uploadCard(item)) await refreshSynced(); } : undefined
		}
	);
}

function updateSynced(cards: ScenarioCard[]) {
	const list = document.querySelector<HTMLElement>("#library-synced")!;
	const local = new Map(cards.map(c => [c.id, c]));
	list.replaceChildren(...synced.map(h => syncedCardView(h, local.get(h.id))));
	list.hidden = synced.length === 0;
}

function syncedCardView(handle: CardSyncHandle, local: ScenarioCard | undefined) {
	const status = !local
		? "not on this device"
		: local.lastUpdate === handle.lastUpdate
			? "same as the copy on this device"
			: local.lastUpdate < handle.lastUpdate
				? "newer than the copy on this device"
				: "older than the copy on this device";
	return makeSyncedCardView(
		handle,
		status,
		local ? "update" : "download",
		{
			download: async () => {
				if (local && local.lastUpdate > handle.lastUpdate && !confirm("The copy on this device is newer. Replace it with the synced one?")) return;
				if (await downloadSyncedCard(handle.id)) await refreshSynced();
			},
			discard: async () => {
				if (!confirm(`Remove the synced copy of "${handle.title}" from the server?`)) return;
				if (await discardSyncedCard(handle.id)) await refreshSynced();
			}
		}
	);
}

function deleteScenario(id: string, name: string) {
	const ok = confirm(`scenario "${name}" will be deleted`);
	if (!ok) return;

	idb.del("scenarios", id);
}

export async function openStartModal(scenario: string, descriptionMD: string) {
	const modal = document.querySelector<RampikeModal>("#library-start")!;
	const picker = modal.querySelector<HTMLSelectElement>("#library-start-persona")!;
	const description = document.querySelector<HTMLElement>("#library-start-description")!;
	const placeholder = modal.querySelector<HTMLElement>("#library-start-placeholder")!;
	const noPlaceholder = modal.querySelector<HTMLElement>("#library-start-no-placeholder")!;

	const personas = await idb.getAll("personas");
	if (!personas.success) return;

	placeholder.hidden = personas.value.length > 0;
	noPlaceholder.style.display = placeholder.hidden ? "contents" : "none";

	setSelectOptions(
		picker,
		personas.value.map(({id, name}) => [id, name]),
		personas.value[0]?.id
	);

	openerRelay = {
		scenarioId: scenario
	};

	description.hidden = descriptionMD.trim() ? false : true;
	description.innerHTML = renderMD(descriptionMD);

	modal.open();
}
