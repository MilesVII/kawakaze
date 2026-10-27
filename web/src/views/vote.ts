import type { Vote } from "@shared/api";
import { mudcrack } from "rampike";

export type VoteResult = { score: number, myVote: Vote };

/** ▲ score ▼; votes toggle off when the same button is pressed again */
export function makeVoteView(
	initial: VoteResult,
	enabled: boolean,
	submit: (value: Vote) => Promise<VoteResult | null>
) {
	let state = initial;
	const up = mudcrack({
		tagName: "button",
		className: "strip ghost pointer kawa-vote",
		attributes: { title: enabled ? "upvote" : "sign in to vote" },
		contents: "▲"
	});
	const down = mudcrack({
		tagName: "button",
		className: "strip ghost pointer kawa-vote",
		attributes: { title: enabled ? "downvote" : "sign in to vote" },
		contents: "▼"
	});
	const score = mudcrack({ tagName: "span", className: "kawa-vote-score" });
	const root = mudcrack({ className: "row-compact align-center kawa-votes", contents: [up, score, down] });

	function render() {
		score.textContent = String(state.score);
		up.toggleAttribute("data-active", state.myVote === 1);
		down.toggleAttribute("data-active", state.myVote === -1);
		up.disabled = down.disabled = !enabled;
	}
	async function cast(value: Vote) {
		const next = state.myVote === value ? 0 : value;
		up.disabled = down.disabled = true;
		const result = await submit(next);
		if (result) state = result;
		render();
	}
	up.addEventListener("click", () => cast(1));
	down.addEventListener("click", () => cast(-1));
	render();

	return root;
}
