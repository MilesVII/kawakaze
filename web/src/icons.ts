import send from "../assets/gfx/send.svg";
import swipe from "../assets/gfx/swipe.svg";

/*
SVG icons, bundled as text (esbuild's --loader:.svg=text): no request per use, and unlike <img> they're part of the
page, so they can be colored with CSS variables. Each markup is parsed once; every use gets a copy.
*/

export const ICONS = { send, swipe };

const parsed = new Map<string, Element>();

export function svgIcon(markup: string, className?: string) {
	let source = parsed.get(markup);
	if (!source) {
		source = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
		parsed.set(markup, source);
	}
	const icon = document.importNode(source, true) as SVGElement;
	if (className) icon.classList.add(className);
	return icon;
}
