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

		this.thumb = mudcrack({
			className: "kon-thumb",
			style: {
				width: "var(--kon-thumb-size)",
				height: "var(--kon-thumb-size)",
				transform: "translateX(var(--kon-dx))"
			},
			events: {
				pointerdown: e => {
					this.state = {
						ox: e.clientX,
						activated: false
					};
				}
			}
		});
		document.addEventListener("pointermove", e => {
			if (!this.state) return;
			const tw = this.clientWidth - this.thumb.clientWidth;
			let dx = e.clientX - this.state.ox;
			if (dx < 0) dx = 0;
			if (dx > tw) {
				dx = tw;
				if (!this.state.activated) {
					this.action?.();
					this.state.activated = true;
					this.dataset.activated = "on";
				}
			}
			this.style.setProperty("--kon-dx", `${dx}px`);
		});
		document.addEventListener("pointerup", () => {
			if (!this.state || this.state.activated) return;
			this.reset();
		});

		this.reset();
		this.append(this.thumb);
	}
};

export function define() {
	window.customElements.define(TAG_NAME, RampikeKon);
}
