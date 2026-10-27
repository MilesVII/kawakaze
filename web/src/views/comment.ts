import html from "./comment.html";
import type { Comment, Vote } from "@shared/api";
import { MENTION_RE } from "@shared/api";
import { placeholder } from "@root/utils";
import { htmlTemplate, mudcrack, sprout } from "rampike";
import { relativeTime, scenarioLink, userLink } from "@units/kawa/catalog";
import { makeVoteView, VoteResult } from "./vote";

export type CommentHandlers = {
	vote?: (value: Vote) => Promise<VoteResult | null>,
	reply?: () => void,
	delete?: () => void
};
export type CommentOptions = {
	/** shows a link to the scenario instead of the reply button, for lists outside the scenario page */
	context?: { title: string },
	canVote: boolean
};

const template = htmlTemplate(html);
const REFS = {
	avatar:  HTMLImageElement,
	name:    HTMLElement,
	time:    HTMLAnchorElement,
	context: HTMLElement,
	body:    HTMLElement,
	votes:   HTMLElement,
	reply:   HTMLButtonElement,
	delete:  HTMLButtonElement
};

export function makeCommentView(comment: Comment, options: CommentOptions, handlers: CommentHandlers) {
	const { root, refs: r } = sprout(template, REFS);
	root.id = `comment-${comment.id}`;

	r.avatar.src = placeholder(comment.author?.icon ?? null);
	if (comment.author) {
		r.name.replaceChildren(mudcrack({
			tagName: "a",
			attributes: { href: userLink(comment.author.username) },
			contents: comment.author.username
		}));
	} else {
		r.name.textContent = "anonymous";
		r.name.classList.add("hint");
	}
	r.time.textContent = relativeTime(comment.createdAt);
	r.time.title = new Date(comment.createdAt).toLocaleString();
	r.time.href = `${scenarioLink(comment.scenarioId)}#comment-${comment.id}`;

	if (options.context) {
		r.context.hidden = false;
		r.context.replaceChildren(
			"on ",
			mudcrack({ tagName: "a", attributes: { href: r.time.href }, contents: options.context.title })
		);
	}

	r.body.append(...linkMentions(comment.body));

	if (handlers.vote)
		r.votes.replaceChildren(makeVoteView({ score: comment.score, myVote: comment.myVote }, options.canVote, handlers.vote));
	else
		r.votes.textContent = `▲ ${comment.score}`;

	if (handlers.reply && comment.author) r.reply.addEventListener("click", handlers.reply);
	else r.reply.hidden = true;
	if (handlers.delete && comment.canDelete) r.delete.addEventListener("click", handlers.delete);
	else r.delete.hidden = true;

	return root;
}

/** plain text with @mentions turned into profile links */
export function linkMentions(text: string): (string | Node)[] {
	const out: (string | Node)[] = [];
	let last = 0;
	for (const match of text.matchAll(new RegExp(MENTION_RE.source, "g"))) {
		const start = match.index! + match[1].length;
		out.push(text.slice(last, start));
		out.push(mudcrack({
			tagName: "a",
			attributes: { href: userLink(match[2]) },
			contents: `@${match[2]}`
		}));
		last = start + match[2].length + 1;
	}
	out.push(text.slice(last));
	return out;
}
