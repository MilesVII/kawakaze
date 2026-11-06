import { mudcrack } from "rampike";

const TAG_NAME = "ram-kon";

export class RampikeKon extends HTMLElement {
	private state: {
		ox: number,
		activated: boolean
	} | null = null;
	thumb: HTMLElement;

	action: null | (() => void) = null;
	reset() {
		this.state = null;
		this.style.setProperty("--kon-dx", "0px");
		this.removeAttribute("data-activated");
	}

	constructor() {
		super();
		const thumbSize = `${this.getAttribute("thumb") ?? "30"}px`;
		this.style.setProperty("--kon-thumb-size", thumbSize);
		this.style.position = "relative";
		this.classList.add("kon-track");
		this.setAttribute("tabindex", "0");
		this.setAttribute("role", "button");

		this.addEventListener("keydown", e => {
			if (
				e.code !== "Enter" &&
				e.code !== "Space" &&
				e.code !== "NumpadEnter"
			) return;
			if (e.repeat) return;
			e.preventDefault();
			this.action?.();
		})
		this.thumb = mudcrack({
			className: "kon-thumb",
			style: {
				width: "var(--kon-thumb-size)",
				height: "var(--kon-thumb-size)",
				transform: "translateX(var(--kon-dx))",
				// @ts-ignore
				"touch-action": "pan-y"
			},
			events: {
				pointerdown: e => {
					this.state = {
						ox: e.clientX,
						activated: false
					};
					this.thumb.setPointerCapture(e.pointerId);
				}
			}
		});
		this.thumb.addEventListener("pointermove", e => {
			if (!this.state) return;
			const tw = this.clientWidth - this.thumb.clientWidth;
			let dx = e.clientX - this.state.ox;
			if (dx < 0) dx = 0;
			if (dx > tw) {
				dx = tw;
				if (!this.state.activated) {
					this.state.activated = true;
					this.dataset.activated = "on";
				}
			} else {
				this.state.activated = false;
				this.removeAttribute("data-activated");
			}
			this.style.setProperty("--kon-dx", `${dx}px`);
		});
		const drop = () => {
			if (!this.state) return;
			if (this.state.activated) {
				this.action?.();
			}
			this.reset();
		};
		this.thumb.addEventListener("pointerup", drop);
		this.thumb.addEventListener("pointercancel", this.reset);

		this.reset();
		this.append(this.thumb);
	}
};

export function define() {
	window.customElements.define(TAG_NAME, RampikeKon);
}
