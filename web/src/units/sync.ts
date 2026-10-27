import type { SyncHandle, SyncPayload } from "@shared/api";
import { account, api } from "@root/api";
import { encodeMedia, storeMedia } from "@root/media";
import { idb } from "@root/persist";
import { toast } from "./toasts";

/*
Manual chat migration between devices. Upload puts a copy on the server; download imports it and removes the
server copy, so the two never drift apart.
*/

export async function uploadChat(chatId: string) {
	if (!account.get()) {
		toast("sign in to use chat sync");
		return false;
	}
	const [chat, contents] = await Promise.all([
		idb.get("chats", chatId),
		idb.get("chatContents", chatId)
	]);
	if (!chat.success || !chat.value || !contents.success || !contents.value) {
		toast("can't read the chat");
		return false;
	}
	const close = toast("uploading chat...");
	const payload: SyncPayload = {
		chat: chat.value,
		contents: contents.value,
		media: await encodeMedia([chat.value.userPersona.picture, chat.value.scenario.picture], false)
	};
	const r = await api<SyncHandle>("PUT", `/api/sync/${encodeURIComponent(chatId)}`, payload);
	close();
	if (!r.success) {
		toast(`upload failed: ${r.error}`);
		return false;
	}
	toast("chat uploaded: download it on another device from the chat list");
	return true;
}

export async function listSynced(): Promise<SyncHandle[]> {
	if (!account.get()) return [];
	const r = await api<SyncHandle[]>("GET", "/api/sync");
	return r.success ? r.value : [];
}

export async function downloadSynced(id: string) {
	const r = await api<SyncPayload>("GET", `/api/sync/${encodeURIComponent(id)}`);
	if (!r.success) {
		toast(`download failed: ${r.error}`);
		return false;
	}
	const { chat, contents, media } = r.value;
	await storeMedia(media ?? []);
	await idb.set("chatContents", contents);
	await idb.set("chats", chat);

	const removed = await api("DELETE", `/api/sync/${encodeURIComponent(id)}`);
	if (!removed.success) toast("chat downloaded, but the server copy could not be removed");
	else toast("chat downloaded");
	return true;
}

export async function discardSynced(id: string) {
	const r = await api("DELETE", `/api/sync/${encodeURIComponent(id)}`);
	if (!r.success) toast(`can't remove: ${r.error}`);
	return r.success;
}
