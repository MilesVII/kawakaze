import { getRoute, onRoute } from "@root/router";
import { renderMD } from "@root/utils";

/* Small Kawakaze pages: terms of use */

export function termsUnit() {
	let loaded = false;
	const load = async () => {
		if (getRoute()[0] !== "terms" || loaded) return;
		const r = await fetch("/assets/docs/terms.md");
		if (!r.ok) return;
		loaded = true;
		document.querySelector<HTMLElement>("#terms-content")!.innerHTML = renderMD(await r.text());
	};
	onRoute(load);
	load();
}
