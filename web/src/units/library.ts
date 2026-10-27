import { getBlobLink, idb, isRemoteRef, listen, upload } from "@root/persist";
import { b64Encoder, download, renderMD, setSelectOptions } from "@root/utils";
import { navigate } from "@root/router";
import { account } from "@root/api";
import { encodeRef } from "@root/media";
import { mudcrack } from "rampike";
import type { ScenarioLookup } from "@shared/api";
import { lookupScenarios, saveToLibrary, scenarioLink } from "./kawa/catalog";
import { placeholderView } from "@views/common";
import { makeScenarioCardView } from "@views/scenario-card";
import { RampikeModal } from "@rampike/modal";
import { start } from "./chat/start";
import { ScenarioCard } from "@root/types";
import { RampikeFilePicker } from "@rampike/filepicker";
import { importSTMessages } from "./library/st";
import { downloadScenarioCard } from "./library/dl";
import { toast } from "./toasts";
import { startArmory } from "./library/armory";
import { DatacatCard, importDatacatJSON } from "./library/datacat";
import { RampikePagination } from "@rampike/pagination";
import { filterBySearch } from "./library/search";
import { hashListenerUnit } from "./library/hash";

const CARDS_PER_PAGE = 16;
let openerRelay: {
	scenarioId: string
} | null = null;

export function libraryUnit() {
	hashListenerUnit();

	const startButton        = document.querySelector<HTMLButtonElement>("#library-start-button")!;
	const startPersonaPicker = document.querySelector<HTMLSelectElement>("#library-start-persona")!;
	const startImportButton  = document.querySelector<RampikeFilePicker>("#library-start-import")!;
	const importButton       = document.querySelector<RampikeFilePicker>("#library-import")!;
	const armoryButton       = document.querySelector<HTMLButtonElement>("#library-armory-button")!;
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

	armoryButton.addEventListener("click", startArmory);

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
	account.listen(() => update());
	listen(async u => {
		if (u.storage !== "idb") return;
		if (u.store !== "scenarios") return;

		update();
	});
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

	const published = await lookupScenarios(pageItems.map(i => i.id));
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
			edit:     () => navigate(`/editor/${encodeURIComponent(item.id)}`)
		}
	);
}

async function downloadScenario(card: ScenarioCard) {
	const payload = { ...card };

	payload.card = { ...card.card, picture: await encodeRef(card.card.picture) };
	payload.chat = { ...card.chat, picture: await encodeRef(card.chat.picture) };

	const filename = [payload.card.title, payload.chat.name].filter(t => t).join(" | ");
	download(JSON.stringify(payload), `${filename}.aegir.scenario.json`);
}

export async function importScenario(file: Blob) {
	const raw = await file.text();
	const parsed = JSON.parse(raw) as ScenarioCard | DatacatCard;

	if ("spec" in parsed && parsed.spec === "chara_card_v2") {
		const converted = await importDatacatJSON(parsed);
		idb.set("scenarios", converted);
	}
	if ("id" in parsed){
		async function decode(b64: string | null) {
			if (!b64) return null;
			if (isRemoteRef(b64)) return b64;
			const file = await b64Encoder.decode(b64);
			const media = await upload(file);
			return media;
		}
		parsed.card.picture = await decode(parsed.card.picture);
		parsed.chat.picture = await decode(parsed.chat.picture);
		parsed.lastUpdate = Date.now();
	
		idb.set("scenarios", parsed);
	}
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
