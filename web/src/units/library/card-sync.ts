import type { CardSyncHandle } from "@shared/api";
import { account, api } from "@root/api";
import { ScenarioCard } from "@root/types";
import { toast } from "../toasts";
import { exportScenario, restoreScenario } from "./files";

/*
Manual card migration between devices, like chat sync (units/sync.ts). The server keeps the card in the export format,
local pictures inside as base64 and server ones as URLs; downloading imports it like a file and removes the server copy,
so the copies never drift apart.
*/

const path = (id: string) => `/api/card-sync/${encodeURIComponent(id)}`;

export async function uploadCard(card: ScenarioCard) {
	if (!account.get()) {
		toast("sign in to use card sync");
		return false;
	}
	const close = toast("uploading card...");
	// server pictures stay URLs, like in chat sync: they resolve the same on every device and don't count twice
	const r = await api<CardSyncHandle>("PUT", path(card.id), await exportScenario(card, false));
	close();
	if (!r.success) {
		toast(`upload failed: ${r.error}`);
		return false;
	}
	toast("card uploaded: download it on another device from the library");
	return true;
}

export async function listSyncedCards(): Promise<CardSyncHandle[]> {
	if (!account.get()) return [];
	const r = await api<CardSyncHandle[]>("GET", "/api/card-sync");
	return r.success ? r.value : [];
}

export async function downloadSyncedCard(id: string) {
	const r = await api<ScenarioCard>("GET", path(id));
	if (!r.success) {
		toast(`download failed: ${r.error}`);
		return false;
	}
	if (!(await restoreScenario(r.value, true))) {
		toast("can't save the card");
		return false;
	}
	const removed = await api("DELETE", path(id));
	if (!removed.success) toast("card downloaded, but the server copy could not be removed");
	else toast("card downloaded");
	return true;
}

export async function discardSyncedCard(id: string) {
	const r = await api("DELETE", path(id));
	if (!r.success) toast(`can't remove: ${r.error}`);
	return r.success;
}
