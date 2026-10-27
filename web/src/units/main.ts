import { navigate } from "@root/router";
import { RampikeFilePicker } from "@rampike/filepicker";
import { nothrow, unique, placeholder } from "@root/utils";
import { account } from "@root/api";
import { getRoute, onRoute } from "@root/router";
import { storeMedia } from "@root/media";
import { discardSynced, downloadSynced, listSynced } from "./sync";
import type { SyncHandle } from "@shared/api";
import { Chat, ChatContents, Folder } from "@root/types";
import { getBlobLink, idb, listen } from "@root/persist";
import { mudcrack } from "rampike";
import { cheatHandler } from "./cheats";
import { placeholderView } from "@views/common";
import { makeChatHandleView, messagesCaption } from "@views/chat-handle";
import { makeSyncedHandleView } from "@views/synced-handle";


export function mainUnit() {
	const importButton = document.querySelector<RampikeFilePicker>("#main-import")!;
	const chatCounter = document.querySelector<HTMLElement>("#main-counter")!;

	importButton.addEventListener("input", () => {
		const file = importButton.input.files?.[0];
		if (!file) return;

		importChat(file);
	});
	chatCounter.addEventListener("click", cheatHandler)

	listen(u => {
		if (u.storage !== "idb") return;
		if (u.store !== "chats") return;

		update(currentFolder);
	});
	account.listen(me => {
		if (!me) synced = [];
		if (getRoute()[0] === "chats" || !me) refreshSynced();
	});
	onRoute(() => {
		if (getRoute()[0] === "chats") refreshSynced();
	});
	update(null);
}

let currentFolder: Folder = null;
let synced: SyncHandle[] = [];
async function refreshSynced() {
	synced = await listSynced();
	update(currentFolder);
}

async function update(folder: Folder) {
	currentFolder = folder;
	const chatCounter = document.querySelector<HTMLElement>("#main-counter")!;

	const handles = await idb.getAll("chats");
	if (!handles.success) return;

	const cc = handles.value.length;
	const singular = cc === 1 || ((cc % 10 === 1) && (cc % 100 !== 11));
	chatCounter.textContent = `${handles.value.length} ${singular ? "chat" : "chats"}`;

	const folderOptions = unique(handles.value.map(c => c.folder).filter(f => f) as string[]);

	updateChatHandles(handles.value, folder, folderOptions);
	updateFolders(folder, folderOptions, update);
}

function updateChatHandles(handles: Chat[], folder: Folder, folderOptions: string[]) {
	const list = document.querySelector("#main-chats")!;

	list.innerHTML = "";

	const filtered = folder ? handles.filter(c => c.folder === folder) : handles;
	const local = new Map(handles.map(c => [c.id, c]));
	// synced chats sit among local ones; folders only apply to local chats
	const remote = folder ? [] : synced;
	const items = [
		...filtered.map(c => [c.lastUpdate, () => handleView(c, folderOptions)] as const),
		...remote.map(h => [h.lastUpdate, () => syncedView(h, local.get(h.id))] as const)
	]
		.sort((a, b) => b[0] - a[0])
		.map(([, view]) => view());

	if (items.length === 0) list.append(placeholderView("No chats found"));
	list.append(...items);
}

function updateFolders(folder: Folder, options: string[], onChange: (folder: Folder) => void) {
	const folders = document.querySelector<HTMLElement>("#main-folders")!;
	folders.innerHTML = "";
	const folderButton = (f: Folder) => mudcrack({
		tagName: "button",
		className: "strip fit pointer",
		events: {
			click: () => {
				updateFolders(f, options, onChange);
				onChange(f);
			}
		},
		attributes: {
			"data-selected": folder === f ? "true" : "not true"
		},
		contents: f || "all chats"
	});
	folders.append(
		folderButton(null),
		...options.map(folderButton)
	);
	// folders.hidden = options.length === 0;
}

function handleView(handle: Chat, folderOptions: string[]) {
	return makeChatHandleView(
		handle,
		{
			scenario: handle.scenario.picture    ? getBlobLink(handle.scenario.picture)    : null,
			user:     handle.userPersona.picture ? getBlobLink(handle.userPersona.picture) : null
		},
		folderOptions,
		{
			play:         () => navigate(`/play/${handle.id}`),
			delete:       () => deleteChat(handle.id, handle.scenario.name, handle.messageCount),
			setMemo:      () => setMemo(handle.id, handle.memo),
			assignFolder: folder => assignToFolder(handle.id, folder),
			newFolder:    () => {
				const newName = prompt("Enter the name of the new folder")?.trim();
				if (!newName) return;
				assignToFolder(handle.id, newName);
			}
		}
	);
}

function deleteChat(id: string, name: string, messageCount: number) {
	const confirmed = confirm(`Chat with ${name} (${messagesCaption(messageCount)}) will be deleted`);
	if (!confirmed) return;

	idb.del("chatContents", id);
	idb.del("chats", id);
}
async function assignToFolder(id: string, folder: string | null) {
	const chat = await idb.get("chats", id);
	if (!chat.success) return false;
	chat.value.folder = folder;
	await idb.set("chats", chat.value);
	return true;
}
async function setMemo(id: string, old?: string) {
	const newMemo = prompt("set chat memo", old ?? "");
	if (newMemo === null) return;

	const chat = await idb.get("chats", id);
	if (!chat.success) return false;
	chat.value.memo = newMemo || undefined;
	await idb.set("chats", chat.value);
}

async function importChat(file: File) {
	const json = await file.text();
	const parsed = nothrow(() => JSON.parse(json));
	if (!parsed.success) return;

	const chat     = parsed.value.chat as Chat;
	const contents = parsed.value.contents as ChatContents;
	const media    = parsed.value.media;

	await storeMedia(media ?? []);

	await idb.set("chats", chat);
	await idb.set("chatContents", contents);
}

function syncedView(handle: SyncHandle, local: Chat | undefined) {
	const status = !local
		? "not on this device"
		: local.lastUpdate < handle.lastUpdate
			? "newer than the copy on this device"
			: "older than the copy on this device";
	return makeSyncedHandleView(
		handle,
		status,
		local ? "update" : "download",
		{
			download: async () => {
				if (local && local.lastUpdate > handle.lastUpdate && !confirm("The copy on this device is newer. Replace it with the synced one?")) return;
				if (await downloadSynced(handle.id)) await refreshSynced();
			},
			discard: async () => {
				if (!confirm(`Remove the synced copy of "${handle.name}" from the server?`)) return;
				if (await discardSynced(handle.id)) await refreshSynced();
			}
		}
	);
}
