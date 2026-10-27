import { account } from "@root/api";
import { getRoute, onRoute } from "@root/router";
import { renderMD } from "@root/utils";
import { toast } from "@units/toasts";
import { localHiddenTags, parseTags, setLocalHiddenTags } from "./catalog";

/* Small Kawakaze pages and settings: terms of use, hidden tags for guests */

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

export function hiddenTagsSettingUnit() {
	const input = document.querySelector<HTMLTextAreaElement>("#settings-hidden-tags")!;
	const save  = document.querySelector<HTMLButtonElement>("#settings-hidden-save")!;
	const note  = document.querySelector<HTMLElement>("#settings-hidden-signed")!;

	const render = () => {
		const me = account.get();
		note.hidden = !me;
		input.disabled = save.disabled = !!me;
		input.value = (me?.hiddenTags ?? localHiddenTags()).join(", ");
	};
	save.addEventListener("click", () => {
		setLocalHiddenTags(parseTags(input.value));
		toast("hidden tags saved");
	});
	account.listen(render);
	render();
}
