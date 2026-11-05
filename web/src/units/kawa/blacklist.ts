import { LIMITS, type Me } from "@shared/api";
import { RampikeModal } from "@rampike/modal";
import { account, api } from "@root/api";
import { textareaReconsider } from "@root/utils";
import { toast } from "@units/toasts";
import { hiddenTags, localHiddenTags, parseTags, setLocalHiddenTags } from "./catalog";
import { attachTagSuggestions } from "./tag-suggestions";

/*
The blacklist: tags whose characters are shown under a cover. It is one list with one editor, the homepage button,
so there's a single place to look for it. Guests keep it in this browser, signed-in users in their profile.
Signing up moves the browser's list to the new (still empty) profile; the server marks that redirect with ?signedup=1.
*/

export function blacklistUnit() {
	const openButton = document.querySelector<HTMLButtonElement>("#home-blacklist")!;
	const modal      = document.querySelector<RampikeModal>("#blacklist-modal")!;
	const input      = document.querySelector<HTMLTextAreaElement>("#blacklist-tags")!;
	const where      = document.querySelector<HTMLElement>("#blacklist-where")!;
	const save       = document.querySelector<HTMLButtonElement>("#blacklist-save")!;
	const close      = document.querySelector<HTMLButtonElement>("#blacklist-close")!;
	attachTagSuggestions(input, "hidden");

	openButton.addEventListener("click", () => {
		input.value = hiddenTags().join(", ");
		where.textContent = account.get()
			? "Saved to your profile, so it applies wherever you sign in."
			: "Saved in this browser. Signing up keeps it.";
		modal.open();
		textareaReconsider(input);
	});
	close.addEventListener("click", () => modal.close());
	save.addEventListener("click", async () => {
		const tags = parseTags(input.value);
		if (tags.length > LIMITS.hiddenTags) return toast(`at most ${LIMITS.hiddenTags} tags`);
		if (account.get()) {
			save.disabled = true;
			const r = await api<Me>("PATCH", "/api/me", { hiddenTags: tags });
			save.disabled = false;
			if (!r.success) return toast(r.error);
			account.set(r.value);
		} else {
			setLocalHiddenTags(tags);
		}
		modal.close();
		toast("blacklist saved");
	});

	const url = new URL(location.href);
	if (url.searchParams.has("signedup")) {
		url.searchParams.delete("signedup");
		history.replaceState(history.state, "", url.pathname + url.search + url.hash);
		account.ready().then(adoptBrowserList);
	}
}

async function adoptBrowserList(me: Me | null) {
	if (!me) return;
	const local = localHiddenTags().slice(0, LIMITS.hiddenTags);
	if (local.length === 0) return;
	const r = await api<Me>("PATCH", "/api/me", { hiddenTags: local });
	if (!r.success) return toast(`couldn't move this browser's blacklist to your profile: ${r.error}`);
	account.set(r.value);
	toast("this browser's blacklist is now saved to your profile");
}
