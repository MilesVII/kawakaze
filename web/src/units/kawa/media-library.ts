import { LIMITS, type MediaItem, type MediaLibrary, type MediaUse } from "@shared/api";
import { RampikeFilePicker } from "@rampike/filepicker";
import { RampikeModal } from "@rampike/modal";
import { account, api } from "@root/api";
import { optimizeToWEBP } from "@root/optimizer";
import { formatBytes, nothrowAsync } from "@root/utils";
import { placeholderView } from "@views/common";
import { toast } from "@units/toasts";
import { mudcrack } from "rampike";

/*
The media library, from the scenario editor: creators upload pictures to the server and copy them as markdown
into descriptions and messages. Uploads go through the same conversion as card pictures (webp here, re-encoded
on the server) and count against the same media quota. The list also has the user's other uploads: icons, card pictures,
pictures of cards they forked. Each shows where it's linked on Kawakaze; unused ones are marked so they're easy to clean up.
Deleting takes a picture off the user's uploads; the file goes when nobody else has it among theirs.
*/

export function mediaLibraryUnit() {
	const openButton = document.querySelector<HTMLButtonElement>("#scenario-media-button")!;
	const modal      = document.querySelector<RampikeModal>("#media-modal")!;
	const picker     = document.querySelector<RampikeFilePicker>("#media-picker")!;
	const picked     = document.querySelector<HTMLElement>("#media-picked")!;
	const upload     = document.querySelector<HTMLButtonElement>("#media-upload")!;
	const close      = document.querySelector<HTMLButtonElement>("#media-close")!;
	const quota      = document.querySelector<HTMLProgressElement>("#media-quota")!;
	const quotaText  = document.querySelector<HTMLElement>("#media-quota-text")!;
	const list       = document.querySelector<HTMLElement>("#media-list")!;
	const pickedHint = picked.textContent ?? "";

	account.listenIdentity(me => {
		openButton.hidden = !me?.isCreator;
		if (!me?.isCreator) modal.close();
	});

	openButton.addEventListener("click", async () => {
		modal.open();
		const r = await api<MediaLibrary>("GET", "/api/me/media");
		if (!r.success) return toast(`can't load the media library: ${r.error}`);
		render(r.value);
	});
	close.addEventListener("click", () => modal.close());

	const files = () => Array.from(picker.input.files ?? []);
	function resetPicker() {
		picker.input.value = "";
		picked.textContent = pickedHint;
		upload.disabled = true;
	}
	picker.addEventListener("input", () => {
		const n = files().length;
		picked.textContent = n === 1 ? files()[0].name : `${n} pictures picked`;
		upload.disabled = n === 0;
	});

	upload.addEventListener("click", async () => {
		const queue = files();
		if (queue.length === 0) return;
		upload.disabled = true;
		let done = 0;
		for (const [i, file] of queue.entries()) {
			picked.textContent = queue.length > 1 ? `uploading ${i + 1} of ${queue.length}: ${file.name}` : `uploading ${file.name}`;
			const optimized = await nothrowAsync(optimizeToWEBP(file));
			const blob = optimized.success ? optimized.value[0] : file;
			if (blob.size > LIMITS.pictureBytes) {
				toast(`${file.name} is larger than ${formatBytes(LIMITS.pictureBytes)}`);
				continue;
			}
			const form = new FormData();
			form.append("picture", blob, file.name.replace(/\.[^.]*$/, "") + ".webp");
			const r = await api<MediaLibrary>("POST", "/api/me/media", form);
			if (!r.success) {
				toast(`can't upload ${file.name}: ${r.error}`);
				if (r.error.includes("quota")) break;
				continue;
			}
			done++;
			render(r.value);
		}
		resetPicker();
		if (done > 0) toast(done === 1 ? "picture uploaded" : `${done} pictures uploaded`);
	});

	function render(library: MediaLibrary) {
		quota.max = library.quotaBytes;
		quota.value = Math.min(library.usedBytes, library.quotaBytes);
		quotaText.textContent = `${formatBytes(library.usedBytes)} of ${formatBytes(library.quotaBytes)} used`;
		list.replaceChildren(...(library.items.length
			? library.items.map(item => itemView(item, () => remove(item)))
			: [placeholderView("No pictures yet")]));
	}

	async function remove(item: MediaItem) {
		const uses = describeUses(item);
		const message = item.shared
			? "Remove this picture from your media library?\n\nSomeone else has it among their uploads too, so it stays online and links to it keep working."
			: [
				uses.length ? `It's used in: ${uses.join(", ")}.` : "",
				"Delete this picture? Links to it stop working everywhere: on Kawakaze and wherever else they were pasted.",
				"Copies people already saved or still have cached aren't affected."
			].filter(Boolean).join("\n\n");
		if (!confirm(message)) return;
		const r = await api<MediaLibrary>("DELETE", `/api/me/media/${item.hash}`);
		if (!r.success) return toast(`can't delete the picture: ${r.error}`);
		render(r.value);
		toast(item.shared ? "removed from your media library" : "picture deleted");
		if (item.uses.some(u => u.kind === "icon" && u.mine)) account.refresh();
	}
}

/** the user's own uses first */
function describeUses(item: MediaItem) {
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

function itemView(item: MediaItem, remove: () => void) {
	const markdown = `![](${item.url})`;
	const uses = describeUses(item);
	const usesText = uses.length === 0 ? "unused"
		: uses.length <= 2 ? uses.join(", ")
		: `${uses.slice(0, 2).join(", ")} and ${uses.length - 2} more`;
	return mudcrack({
		className: `list${uses.length ? "" : " media-unused"}`,
		contents: [
			mudcrack({
				tagName: "a",
				attributes: { href: item.url, target: "_blank", rel: "noopener", title: "open in a new tab" },
				contents: [mudcrack({ tagName: "img", className: "lineout", attributes: { src: item.url, loading: "lazy", alt: "" } })]
			}),
			mudcrack({ className: "hint center-text", contents: `${item.width}×${item.height}, ${formatBytes(item.bytes)}` }),
			mudcrack({
				className: `hint center-text media-uses${uses.length ? "" : " kawa-accent"}`,
				attributes: { title: uses.length ? `used in:\n${uses.join("\n")}` : "not linked from any card, bio or profile picture on Kawakaze" },
				contents: usesText
			}),
			mudcrack({
				tagName: "button",
				className: "lineout",
				contents: "copy markdown",
				events: {
					click: async e => {
						const button = e.currentTarget as HTMLElement;
						const copied = (await nothrowAsync(navigator.clipboard.writeText(markdown))).success
							|| copyBySelection(markdown, button);
						toast(copied ? "markdown copied" : `can't copy: ${markdown}`);
					}
				}
			}),
			mudcrack({
				tagName: "button",
				className: "lineout",
				contents: item.shared ? "remove" : "delete",
				events: { click: remove }
			})
		]
	});
}

/** the old way, for browsers that keep the clipboard API from pages; the field goes next to `near`, inside the modal */
function copyBySelection(text: string, near: HTMLElement) {
	const field = mudcrack({ tagName: "textarea", style: { position: "fixed", opacity: "0" } }) as HTMLTextAreaElement;
	field.value = text;
	near.after(field);
	field.select();
	let copied = false;
	try {
		copied = document.execCommand("copy");
	} catch {}
	field.remove();
	near.focus();
	return copied;
}
