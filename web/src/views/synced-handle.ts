import html from "./synced-handle.html";
import type { SyncHandle } from "@shared/api";
import { placeholder } from "@root/utils";
import { htmlTemplate, sprout } from "rampike";
import { messagesCaption } from "./chat-handle";

export type SyncedHandleHandlers = {
	download: () => void,
	discard: () => void
};

const template = htmlTemplate(html);
const REFS = {
	icon:     HTMLImageElement,
	title:    HTMLElement,
	persona:  HTMLElement,
	messages: HTMLElement,
	status:   HTMLElement,
	download: HTMLButtonElement,
	discard:  HTMLButtonElement
};

/** A chat waiting on the server, shown among local chats */
export function makeSyncedHandleView(handle: SyncHandle, status: string, downloadCaption: string, handlers: SyncedHandleHandlers) {
	const { root, refs: r } = sprout(template, REFS);

	r.icon.src = placeholder(handle.picture);
	r.title.textContent = handle.name;
	r.persona.textContent = handle.personaName;
	r.messages.textContent = messagesCaption(handle.messageCount);
	r.status.textContent = `⇅ synced ${new Date(handle.uploadedAt).toLocaleString()}, ${status}`;
	r.download.textContent = downloadCaption;

	r.download.addEventListener("click", handlers.download);
	r.discard.addEventListener("click", handlers.discard);

	return root;
}
