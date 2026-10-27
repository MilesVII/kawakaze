import type { PublicUser } from "@shared/api";
import { api } from "@root/api";
import { getRoute, navigate, onRoute } from "@root/router";
import { placeholder, renderMD, updateTitle } from "@root/utils";
import { makeKawaCardView } from "@views/kawa-card";
import { onHiddenTagsChange } from "./catalog";

/* Public user page: /u/:username */

let shown: PublicUser | null = null;

export function userPageUnit() {
	document.querySelector<HTMLButtonElement>("#up-back")!.addEventListener("click", () => {
		if (history.length > 1) history.back();
		else navigate("/");
	});
	onRoute(() => {
		if (getRoute()[0] === "u") load();
	});
	onHiddenTagsChange(() => {
		if (getRoute()[0] === "u" && shown) render(shown);
	});
	if (getRoute()[0] === "u") load();
}

async function load() {
	const name = getRoute()[1];
	const status  = document.querySelector<HTMLElement>("#up-status")!;
	const content = document.querySelector<HTMLElement>("#up-content")!;
	if (!name) return;
	if (shown && shown.user.username.toLowerCase() === name.toLowerCase()) {
		updateTitle(shown.user.username);
		return;
	}

	shown = null;
	content.hidden = true;
	status.hidden = false;
	status.textContent = "Loading...";
	const r = await api<PublicUser>("GET", `/api/users/${encodeURIComponent(name)}`);
	if (getRoute()[1] !== name) return;
	if (!r.success) {
		status.textContent = r.error;
		return;
	}
	shown = r.value;
	status.hidden = true;
	content.hidden = false;
	render(r.value);
}

function render({ user, scenarios }: PublicUser) {
	updateTitle(user.username);
	document.querySelector<HTMLImageElement>("#up-icon")!.src = placeholder(user.icon);
	document.querySelector<HTMLElement>("#up-name")!.textContent = user.username;
	document.querySelector<HTMLElement>("#up-meta")!.textContent = [
		user.isCreator ? "creator" : null,
		`joined ${new Date(user.createdAt).toLocaleDateString()}`
	].filter(t => t).join(" · ");
	document.querySelector<HTMLElement>("#up-bio")!.innerHTML = renderMD(user.bio || "");
	document.querySelector<HTMLElement>("#up-cards-label")!.hidden = scenarios.length === 0;
	document.querySelector<HTMLElement>("#up-cards")!.replaceChildren(...scenarios.map(s => makeKawaCardView(s, {
		tag: tag => navigate(`/?tag=${encodeURIComponent(tag)}`)
	})));
}

/** drop the cached page after the signed-in user edits their own profile */
export function forgetUserPage() {
	shown = null;
}
