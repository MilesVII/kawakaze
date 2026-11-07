import { mudcrack } from "rampike";
import { MODAL_CLOSE, MODAL_OPEN, type RampikeModal } from "@rampike/modal";

type ToastOptions = {
	timeoutMS?: number,
	actions?: [caption: string, cb: (close: () => void) => void][]
};

/**
 * A modal dialog sits in the top layer and makes the rest of the page inert, so toasts outside it
 * would show under its backdrop and ignore clicks. The container moves into the topmost open modal
 * and back when it closes; the dialog covers the viewport, so the toasts keep their place.
 */
export function toastsUnit() {
	const container = document.querySelector<HTMLElement>("#toast-container")!;
	const home = container.parentElement!;
	const open: RampikeModal[] = [];
	const forget = (modal: RampikeModal) => {
		const ix = open.indexOf(modal);
		if (ix !== -1) open.splice(ix, 1);
	};
	const settle = () => (open.at(-1)?.dialog ?? home).append(container);

	document.addEventListener(MODAL_OPEN, e => {
		forget(e.target);
		open.push(e.target);
		settle();
	});
	document.addEventListener(MODAL_CLOSE, e => {
		forget(e.target);
		settle();
	});
}

export function toast(message: string, options?: ToastOptions) {
	const list = document.querySelector("#toast-container")!;
	
	const rects = Array.from(list.children).map(t => t.getBoundingClientRect());
	const totalH = rects.reduce((p, c) => p + c.height, 0);
	let closed = false;

	const actions = options?.actions
		? options.actions.map(([caption, cb]) => 
			mudcrack({
				tagName: "button",
				className: "lineout",
				contents: caption,
				events: {
					click: () => !closed && cb(close)
				}
			})
		)
		: [];

	const item = mudcrack({
		tagName: "div",
		className: "toast list pointer",
		contents: [
			mudcrack({
				tagName: "div",
				contents: message
			}),
			mudcrack({
				tagName: "div",
				className: "row-compact jc-end",
				style: actions.length
					? {}
					: { display: "none" },
				contents: actions
			})
		],
		style: {
			left: "var(--gap)",
			bottom: `calc(${totalH}px + var(--gap) * ${rects.length + 1})`,
			transform: "translateX(calc(-100% - var(--gap) * 2))"
		},
		events: {
			click: () => !options?.actions && close()
		}
	});

	function close() {
		if (closed) return;
		closed = true;

		const { width } = item.getBoundingClientRect();
		item.style.left = `calc(${-width}px - var(--gap))`;
		item.addEventListener("transitionend", () => {
			item.remove();
			squish();
		});
	}

	list.append(item);
	setTimeout(() => item.style.transform = `translateX(0px)`, 100);

	if (options?.timeoutMS) {
		setTimeout(close, options.timeoutMS);
	}

	return close;
}

function squish() {
	const list = document.querySelector<HTMLElement>("#toast-container")!;

	let totalH = 0;
	const items = Array.from(list.children) as HTMLElement[];
	items.forEach((item, ix) => {
		const { height } = item.getBoundingClientRect();
		item.style.bottom = `calc(${totalH}px + var(--gap) * ${ix + 1})`;
		totalH += height;
	});
}
