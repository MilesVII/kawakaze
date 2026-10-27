import html from "./kawa-card.html";
import type { ScenarioListItem } from "@shared/api";
import { neatNumber, placeholder } from "@root/utils";
import { htmlTemplate, mudcrack, sprout } from "rampike";
import { hiddenMatches, relativeTime, scenarioLink, userLink } from "@units/kawa/catalog";

export type KawaCardHandlers = {
	tag?: (tag: string) => void
};

const template = htmlTemplate(html);
const REFS = {
	"picture-link": HTMLAnchorElement,
	icon:           HTMLImageElement,
	title:          HTMLAnchorElement,
	score:          HTMLElement,
	comments:       HTMLElement,
	authors:        HTMLElement,
	meta:           HTMLElement,
	snippet:        HTMLElement,
	tags:           HTMLElement,
	cover:          HTMLElement,
	"cover-tags":   HTMLElement,
	reveal:         HTMLButtonElement
};

/** A published card in the catalog grid: snippet instead of the description */
export function makeKawaCardView(item: ScenarioListItem, handlers: KawaCardHandlers = {}) {
	const { root, refs: r } = sprout(template, REFS);
	const link = scenarioLink(item.id);

	r["picture-link"].href = link;
	r.icon.src = placeholder(item.picture);
	r.title.href = link;
	r.title.textContent = item.title;
	r.score.textContent = `▲ ${item.score}`;
	r.score.title = `score ${item.score}`;
	if (item.commentCount > 0) {
		r.comments.textContent = `💬 ${item.commentCount}`;
		r.comments.title = `${item.commentCount} comment${item.commentCount === 1 ? "" : "s"}`;
		r.comments.hidden = false;
	}
	r.authors.append(...item.authors.map(a => mudcrack({
		tagName: "a",
		attributes: { href: userLink(a.username) },
		contents: a.username
	})));
	r.meta.textContent = `${neatNumber(item.tokenCount)} tokens · ${relativeTime(item.updatedAt)}`;
	r.meta.title = `published ${new Date(item.publishedAt).toLocaleString()}, edited ${new Date(item.updatedAt).toLocaleString()}`;
	r.snippet.textContent = item.snippet;
	r.tags.append(...item.tags
		.map(tag => mudcrack({
			tagName: "span",
			className: "pointer",
			contents: tag,
			events: { click: () => handlers.tag?.(tag) }
		}))
		.toReversed()
	);

	const hidden = hiddenMatches(item.tags);
	if (hidden.length > 0) {
		r.cover.hidden = false;
		r["cover-tags"].textContent = hidden.join(", ");
		root.classList.add("kawa-covered");
		r.reveal.addEventListener("click", () => {
			r.cover.hidden = true;
			root.classList.remove("kawa-covered");
		});
	}

	return root;
}
