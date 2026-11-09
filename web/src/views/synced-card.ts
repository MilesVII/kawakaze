import html from "./synced-card.html";
import type { CardSyncHandle } from "@shared/api";
import { htmlTemplate, sprout } from "rampike";

export type SyncedCardHandlers = {
	download: () => void,
	discard: () => void
};

const template = htmlTemplate(html);
const REFS = {
	title:     HTMLElement,
	character: HTMLElement,
	status:    HTMLElement,
	download:  HTMLButtonElement,
	discard:   HTMLButtonElement
};

/** A library card waiting on the server; pictures stay inside the payload, so there's no thumbnail */
export function makeSyncedCardView(handle: CardSyncHandle, status: string, downloadCaption: string, handlers: SyncedCardHandlers) {
	const { root, refs: r } = sprout(template, REFS);

	r.title.textContent = handle.title;
	r.character.textContent = handle.characterName;
	r.status.textContent = `⇅ synced ${new Date(handle.uploadedAt).toLocaleString()}, ${status}`;
	r.download.textContent = downloadCaption;

	r.download.addEventListener("click", handlers.download);
	r.discard.addEventListener("click", handlers.discard);

	return root;
}
