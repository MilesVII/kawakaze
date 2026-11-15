import html from "./text-spoiler.html";
import { htmlTemplate, sprout } from "rampike";

const template = htmlTemplate(html);
const REFS = {
	title: HTMLElement,
	copy:  HTMLButtonElement,
	hint:  HTMLElement,
	text:  HTMLElement
};

/** Collapsed plain text with a copy button in the summary: the scenario page's definition and opening messages */
export function makeTextSpoilerView(title: string, text: string, copy: () => void, hint = "") {
	const { root, refs: r } = sprout(template, REFS);

	r.title.textContent = title;
	r.text.textContent = text;
	r.hint.textContent = hint;
	r.hint.hidden = !hint;
	r.copy.addEventListener("click", copy);

	return root;
}
