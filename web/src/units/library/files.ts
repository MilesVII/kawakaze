import { idb, isRemoteRef, upload } from "@root/persist";
import { b64Encoder, download } from "@root/utils";
import { encodeRef } from "@root/media";
import { ScenarioCard } from "@root/types";
import { DatacatCard, importDatacatJSON } from "./datacat";

/*
Library cards as files: the .aegir.scenario.json export, with pictures inside as base64.
Card sync (card-sync.ts) stores the same export, so both go through the same code.
*/

/**
 * Local pictures go inside as base64. Server pictures are fetched and embedded too when `embedRemote` is set,
 * so the file works without this site; one that can't be fetched (another origin: media has no CORS) stays a URL
 * rather than getting lost.
 */
export async function exportScenario(card: ScenarioCard, embedRemote = true): Promise<ScenarioCard> {
	async function embed(ref: string | null) {
		if (!ref) return null;
		if (isRemoteRef(ref) && !embedRemote) return ref;
		return (await encodeRef(ref)) ?? (isRemoteRef(ref) ? ref : null);
	}
	return {
		...card,
		card: { ...card.card, picture: await embed(card.card.picture) },
		chat: { ...card.chat, picture: await embed(card.chat.picture) }
	};
}

export async function downloadScenario(card: ScenarioCard) {
	const payload = await exportScenario(card);
	const filename = [payload.card.title, payload.chat.name].filter(t => t).join(" | ");
	download(JSON.stringify(payload), `${filename}.aegir.scenario.json`);
}

export async function importScenario(file: Blob) {
	const raw = await file.text();
	const parsed = JSON.parse(raw) as ScenarioCard | DatacatCard;

	if ("spec" in parsed && parsed.spec === "chara_card_v2") {
		const converted = await importDatacatJSON(parsed);
		await idb.set("scenarios", converted);
	} else if ("id" in parsed) {
		await restoreScenario(parsed);
	}
}

/**
 * Saves an exported card to the library, replacing the card with the same id.
 * An imported file counts as a fresh change; a synced copy keeps its `lastUpdate`,
 * so it still compares right with the copies on other devices and with the published card.
 */
export async function restoreScenario(exported: ScenarioCard, keepLastUpdate = false) {
	async function decode(b64: string | null) {
		if (!b64) return null;
		if (isRemoteRef(b64)) return b64;
		return await upload(await b64Encoder.decode(b64));
	}
	const card: ScenarioCard = {
		...exported,
		card: { ...exported.card, picture: await decode(exported.card.picture) },
		chat: { ...exported.chat, picture: await decode(exported.chat.picture) },
		lastUpdate: keepLastUpdate ? exported.lastUpdate : Date.now()
	};
	const r = await idb.set("scenarios", card);
	return r.success;
}
