import { idb, upload } from "@root/persist";
import { initProofread } from "./scenario/proofread";
import { getRoute, makeResizable, renderMD, textareaReconsider } from "@root/utils";
import { navigate, onRoute } from "@root/router";
import { account } from "@root/api";
import { LIMITS, KawaScenarioCard, ScenarioLookup } from "@shared/api";
import { delistScenario, lookupScenarios, parseTags, publishScenario } from "./kawa/catalog";
import { invalidateHome } from "./kawa/home";
import { Lorebook, ScenarioCard } from "@root/types";
import { RampikeFilePicker } from "@rampike/filepicker";
import { parseLorebookFile } from "./library/lorebook";
import { makeLorebookItemView } from "@views/lorebook-item";
import { placeholderView } from "@views/common";
import { RampikeImagePicker } from "@rampike/imagepicker";
import { toast } from "./toasts";
import { estimateTokenCount } from "tokenx";
import { RampikeModal } from "@rampike/modal";
import { optimizeToWEBP } from "@root/optimizer";

const definitionTemplate = [
	"# Characters",
	"## {{char}} ",
	"",
	"## {{user}}",
	"{{persona}}",
	"",
	"# Scenario",
	"",
	"# Instructions",
	"The user is {{user}}, all other characters are played by you"
].join("\n");

export function scenarioUnit() {
	const chatIcon         = document.querySelector<RampikeImagePicker> ("#scenario-chat-picture")!;
	const cardIcon         = document.querySelector<RampikeImagePicker> ("#scenario-card-picture")!;
	const cardTitle        = document.querySelector<HTMLInputElement>   ("#scenario-card-title")!;
	const cardSnippet      = document.querySelector<HTMLTextAreaElement>("#scenario-snippet")!;
	const snippetCounter   = document.querySelector<HTMLElement>        ("#scenario-snippet-counter")!;
	const authorHint       = document.querySelector<HTMLElement>        ("#scenario-author")!;
	const publishButton    = document.querySelector<HTMLButtonElement>  ("#scenario-publish-button")!;
	const delistButton     = document.querySelector<HTMLButtonElement>  ("#scenario-delist-button")!;
	const publishStatus    = document.querySelector<HTMLElement>        ("#scenario-publish-status")!;
	const cardDescription  = document.querySelector<HTMLTextAreaElement>("#scenario-description")!;
	const cardTags         = document.querySelector<HTMLTextAreaElement>("#scenario-tags")!;
	const previewModal     = document.querySelector<RampikeModal>       ("#scenario-preview")!;
	const preview          = document.querySelector<HTMLDivElement>     ("#scenario-preview-container")!;
	const previewClose     = document.querySelector<HTMLDivElement>     ("#scenario-preview-close")!;
	const characterName    = document.querySelector<HTMLInputElement>   ("#scenario-character-name")!;
	const definition       = document.querySelector<HTMLTextAreaElement>("#scenario-definition")!;
	const previewButton    = document.querySelector<HTMLButtonElement>  ("#scenario-preview-button")!;
	const submitButton     = document.querySelector<HTMLButtonElement>  ("#scenario-submit-button")!;
	const firstMessage     = document.querySelector<HTMLTextAreaElement>("#scenario-messages")!;
	const lorebookList     = document.querySelector<HTMLElement>        ("#scenario-lorebooks")!;
	const lorebookImport   = document.querySelector<RampikeFilePicker>  ("#scenario-lorebook-import")!;
	makeResizable(cardDescription);
	makeResizable(cardSnippet);
	makeResizable(definition);
	const messagesControl = initFirstMessages();
	initProofread(() => ({
		name: characterName.value,
		definition: definition.value,
		openings: messagesControl.get()
	}));
	/** books attached to the card being edited */
	let lorebooks: Lorebook[] = [];
	/** the card as loaded, so fields this editor doesn't know about survive a save */
	let original: KawaScenarioCard | null = null;
	let remote: ScenarioLookup | null = null;

	const updateSnippetCounter = () => {
		const n = cardSnippet.value.trim().length;
		snippetCounter.textContent = `${n}/${LIMITS.snippet}`;
		snippetCounter.classList.toggle("kawa-accent", n > LIMITS.snippet);
	};
	cardSnippet.addEventListener("input", updateSnippetCounter);

	lorebookImport.addEventListener("input", async () => {
		const file = lorebookImport.input.files?.[0];
		lorebookImport.input.value = "";
		if (!file) return;
		const parsed = await parseLorebookFile(file);
		if (!parsed.success) {
			toast(parsed.error);
			return;
		}
		if (lorebooks.some(b => b.id === parsed.value.id)) {
			toast("this lorebook is already attached");
			return;
		}
		lorebooks.push(parsed.value);
		renderLorebooks();
	});
	function renderLorebooks() {
		lorebookList.innerHTML = "";
		if (lorebooks.length === 0) lorebookList.append(placeholderView("No lorebooks attached"));
		lorebookList.append(...lorebooks.map(book => makeLorebookItemView(book, {
			toggle: enabled => { book.enabled = enabled; },
			remove: () => {
				lorebooks = lorebooks.filter(b => b !== book);
				renderLorebooks();
			}
		})));
	}

	onRoute(load);
	account.listenIdentity(() => {
		if (getRoute()[0] === "editor") updatePublishControls();
	});
	load();

	async function updatePublishControls() {
		const me = account.get();
		const id = getRoute()[1];
		remote = id ? (await lookupScenarios([id])).get(id) ?? null : null;
		const mine = !!me && !!remote && remote.ownerId === me.id;
		publishButton.hidden = !me?.isCreator;
		publishButton.textContent = !remote ? "publish" : mine ? "update" : "publish as fork";
		delistButton.hidden = !(mine && remote && !remote.delisted);

		const lines: string[] = [];
		if (remote && mine) lines.push(remote.delisted
			? "Published, but delisted. Updating it lists it again."
			: `Published, last update ${new Date(remote.updatedAt).toLocaleString()}`);
		if (remote && !mine) lines.push("This card is someone else's. Publishing it creates your fork, crediting the original authors.");
		if (!me) lines.push("Sign in and become a creator to publish characters.");
		else if (!me.isCreator) lines.push("Redeem an invite on your profile to publish characters.");
		publishStatus.textContent = lines.join(" ");
		publishStatus.hidden = lines.length === 0;
	}

	async function load() {
		const path = getRoute();
		if (path[0] !== "editor") return;
		updatePublishControls();
		cardIcon.usePlaceholder();
		chatIcon.usePlaceholder();
		document.body.scrollTo({ behavior: "instant", top: 0 });

		if (path[1]) {
			const scenario = await idb.get("scenarios", path[1]);
			if (!scenario.success || !scenario.value) return;
			original = scenario.value as KawaScenarioCard;
			cardIcon.value        = scenario.value.card.picture ?? "";
			cardTitle.value       = scenario.value.card.title;
			cardSnippet.value     = original["kawa-snippet"]?.summary ?? "";
			showAuthors(original);
			cardDescription.value = scenario.value.card.description;
			cardTags.value        = scenario.value.card.tags.join(", ");

			chatIcon.value        = scenario.value.chat.picture ?? "";
			characterName.value   = scenario.value.chat.name;
			definition.value       = scenario.value.chat.definition;

			messagesControl.set(scenario.value.chat.initials);
			lorebooks = scenario.value.lorebooks ?? [];
		} else {
			original = null;
			cardIcon.usePlaceholder();
			cardTitle.value = "";
			cardSnippet.value = "";
			showAuthors(null);
			cardDescription.value = "";
			cardTags.value = "";

			chatIcon.usePlaceholder();
			characterName.value = "";
			definition.value = definitionTemplate;

			messagesControl.set([""]);
			lorebooks = [];
		}
		renderLorebooks();
		updateSnippetCounter();
		textareaReconsider(cardSnippet);
		textareaReconsider(cardDescription);
		textareaReconsider(definition);
		textareaReconsider(cardTags);
		textareaReconsider(firstMessage);
	}

	function showAuthors(card: KawaScenarioCard | null) {
		const authors = card?.["kawa-authors"] ?? (card?.card.author ? [card.card.author] : []);
		authorHint.hidden = authors.length === 0;
		authorHint.textContent = `Authors: ${authors.map(a => a.name).join(", ")}. Managed automatically on publish.`;
	}

	submitButton.addEventListener("click", async () => {
		const payload = await collect();
		if (!payload) return;
		await idb.set("scenarios", payload);
		toast("saved", { timeoutMS: 3200 })
	});

	publishButton.addEventListener("click", async () => {
		const snippet = cardSnippet.value.trim();
		if (!snippet) {
			toast("a snippet is required for publishing");
			cardSnippet.focus({ preventScroll: true });
			cardSnippet.scrollIntoView({ behavior: "smooth", block: "center" });
			return;
		}
		if (snippet.length > LIMITS.snippet) {
			toast(`the snippet is limited to ${LIMITS.snippet} characters`);
			return;
		}
		if (remote && remote.ownerId !== account.get()?.id && !confirm("Publish your own fork of this card?")) return;

		const payload = await collect();
		if (!payload) return;
		const savedDraft = await idb.set("scenarios", payload);

		publishButton.disabled = true;
		const close = toast("publishing...");
		const r = await publishScenario(payload);
		close();
		publishButton.disabled = false;
		if (!r.success) {
			toast(savedDraft.success
				? `saved locally, but can't publish: ${r.error}`
				: `can't publish: ${r.error}; saving locally failed too: ${savedDraft.error}`);
			return;
		}
		invalidateHome();
		const headline = r.value.forked ? "fork published" : "published";
		const library = !r.value.saved.success
			? `, but saving it to your library failed: ${r.value.saved.error}`
			: r.value.forked
				? ", saved to your library under its new id"
				: " and saved to your library";
		toast(headline + library, {
			actions: [
				["ok", close => close()],
				["open page", close => {
					close();
					navigate(`/c/${encodeURIComponent(r.value.id)}`);
				}]
			]
		});
		if (getRoute()[1] !== r.value.id) navigate(`/editor/${encodeURIComponent(r.value.id)}`, true);
		else load();
	});

	delistButton.addEventListener("click", async () => {
		const id = getRoute()[1];
		if (!id) return;
		if (!confirm("Delist this character? It disappears from the catalog; existing chats keep working. Updating it lists it again.")) return;
		const r = await delistScenario(id);
		if (!r.success) return toast(r.error);
		invalidateHome();
		toast("delisted");
		updatePublishControls();
	});

	/** validates the form, stores new pictures locally and builds the card */
	async function collect(): Promise<KawaScenarioCard | null> {
		const firstMessages = messagesControl.get();

		type Check = [cb: () => any, msg: string, target?: HTMLElement];
		const checks: Check[] = [
			[() => cardTitle.value, "Card name is required", cardTitle],
			[() => definition.value, "Character definiton is required", definition],
			[() => firstMessages.length > 0, "At least one non-empty opening message is required", firstMessage]
		];
		for (const [cb, msg, target] of checks) {
			if (cb()) continue;

			toast(msg);
			target?.focus({ preventScroll: true });
			target?.scrollIntoView({ behavior: "smooth", block: "center" });
			return null;
		}

		const cardPicture = await storePicture(cardIcon);
		const chatPicture = await storePicture(chatIcon);

		const tags = parseTags(cardTags.value);

		const id = getRoute()[1] ?? crypto.randomUUID();
		const snippet = cardSnippet.value.trim();
		const payload: KawaScenarioCard = {
			...(original ?? {}),
			id,
			lastUpdate: Date.now(),
			card: {
				picture: cardPicture,
				title: cardTitle.value,
				description: cardDescription.value,
				tags,
				author: original?.card.author ?? null
			},
			chat: {
				picture: chatPicture,
				name: characterName.value,
				definition: definition.value,
				initials: firstMessages,
				tokenCount: estimateTokenCount(definition.value)
			},
			lorebooks,
			"kawa-snippet": snippet ? { summary: snippet } : undefined
		};
		if (!snippet) delete payload["kawa-snippet"];

		if (!payload.chat.definition.includes("{{persona}}")) {
			toast([
				"warning!\nthe saved definition lacks",
				" {{persona}} macro -- meaning the bot",
				" won't be able to know abything about",
				" user's persona"
			].join(""));
		}

		return payload;
	}

	previewClose.addEventListener("click", () => previewModal.close());
	previewButton.addEventListener("click", () => {
		const content = cardDescription.value;
		preview.innerHTML = renderMD(content);
		previewModal.open();
	});
}

function initFirstMessages() {
	const messagesControls        = document.querySelector<HTMLElement>        ("#scenario-messages-clicker")!;
	const messagesControlsButtons = messagesControls.querySelectorAll("button");
	const messagesControlsCaption = messagesControls.querySelector("div")!;
	const messages                = document.querySelector<HTMLTextAreaElement>("#scenario-messages")!;
	const messagesState: string[] = [""];
	const asterizeButton   = document.querySelector<HTMLButtonElement>  ("#scenario-messages-asterize")!;
	let messageIndex = 0;

	makeResizable(messages);

	function clickMessagesPager(delta: number) {
		let newIndex = messageIndex + delta;
		if (newIndex < 0) newIndex = messagesState.length - 1;
		else if (newIndex >= messagesState.length) {
			if (messagesState[messageIndex].trim()) {
				messagesState.push("");
			} else {
				newIndex = 0;
			}
		}
		messageIndex = newIndex;
		updateMessagesPager();
	}
	function updateMessagesPager() {
		messagesControlsCaption.textContent = `${messageIndex + 1}/${messagesState.length}`;
		messages.value = messagesState[messageIndex];
		textareaReconsider(messages);
	}
	messages.addEventListener("input", () => {
		messagesState[messageIndex] = messages.value;
	});
	messagesControlsButtons[0].addEventListener("click", () => clickMessagesPager(-1));
	messagesControlsButtons[1].addEventListener("click", () => clickMessagesPager(+1));
	updateMessagesPager();

	asterizeButton.addEventListener("click", () => {
		const lines = messages.value.trim().split("\n");
		const asterized = lines.map(line => {
			if (line.trim().length === 0) return "";
			return line.replace(
				/(^|"\s)([^"]+)(\s"|$)/gm,
				(_, g0, g1, g2) => `${g0}*${g1}*${g2}`
			);
		});
		messagesState[messageIndex] =
			messages.value =
				asterized.join("\n");
	});

	return {
		set: (values: string[]) => {
			messagesState.splice(0, messagesState.length);
			messagesState.push(...values);
			messageIndex = 0;
			messages.value = messagesState[messageIndex];
			updateMessagesPager();
		},
		get: () => {
			return messagesState.map(v => v.trim()).filter(v => v);
		}
	};
}

async function storePicture(picker: RampikeImagePicker): Promise<string | null> {
	const value = picker.value;
	if (typeof value === "string") return value || null;

	const [optimized, changed] = await optimizeToWEBP(value);
	if (changed) console.log(`optimized delta: ${optimized.size - value.size} (negative means win)`);
	return await upload(optimized);
}
