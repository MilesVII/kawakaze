import html from "./media-item.html";
import type { MediaItem, MediaUse } from "@shared/api";
import { formatBytes } from "@root/utils";
import { RampikeKon } from "@rampike/kon";
import { htmlTemplate, sprout } from "rampike";

export type MediaItemHandlers = {
	copy: (button: HTMLButtonElement) => void,
	remove: () => void
};

const template = htmlTemplate(html);
const REFS = {
	link:        HTMLAnchorElement,
	picture:     HTMLImageElement,
	size:        HTMLElement,
	uses:        HTMLElement,
	copy:        HTMLButtonElement,
	remove:      RampikeKon,
	removeLabel: HTMLElement
};

/** One tile in the media library: preview, size, where it's used, copy and delete */
export function makeMediaItemView(item: MediaItem, handlers: MediaItemHandlers) {
	const { root, refs: r } = sprout(template, REFS);
	const uses = describeUses(item);

	r.link.href = item.url;
	r.picture.src = item.url;
	r.size.textContent = `${item.width}×${item.height}, ${formatBytes(item.bytes)}`;

	if (uses.length) {
		r.uses.textContent = uses.length <= 2 ? uses.join(", ") : `${uses.slice(0, 2).join(", ")} and ${uses.length - 2} more`;
		r.uses.title = `used in:\n${uses.join("\n")}`;
	} else {
		root.classList.add("media-unused");
		r.uses.classList.add("kawa-accent");
		r.uses.textContent = "unused";
		r.uses.title = "not linked from any card, bio or profile picture on Kawakaze";
	}

	r.copy.addEventListener("click", () => handlers.copy(r.copy));
	if (item.shared) r.removeLabel.textContent = "remove";
	r.remove.action = handlers.remove;

	return root;
}

/** the user's own uses first */
export function describeUses(item: MediaItem) {
	return item.uses.toSorted((a, b) => Number(b.mine) - Number(a.mine)).map(describeUse);
}
function describeUse(use: MediaUse) {
	if (use.kind === "card") {
		if (!use.id) return "someone's delisted card";
		return `${use.mine ? "your card" : "someone's card"} “${use.title}”${use.delisted ? " (delisted)" : ""}`;
	}
	const what = use.kind === "bio" ? "bio" : "profile picture";
	return use.mine ? `your ${what}` : `@${use.username}'s ${what}`;
}
