/* Cloudflare Turnstile, loaded only when an anonymous user is about to comment */

type TurnstileApi = {
	render: (el: HTMLElement, options: Record<string, unknown>) => string,
	reset: (id: string) => void,
	remove: (id: string) => void,
	getResponse: (id: string) => string | undefined
};
declare global {
	interface Window { turnstile?: TurnstileApi }
}

export type TurnstileHandle = {
	token: () => string | null,
	reset: () => void,
	remove: () => void
};

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi | null> | null = null;

function load() {
	loading ??= new Promise(resolve => {
		if (window.turnstile) return resolve(window.turnstile);
		const script = document.createElement("script");
		script.src = SCRIPT_URL;
		script.async = true;
		script.onload = () => resolve(window.turnstile ?? null);
		script.onerror = () => {
			loading = null;
			resolve(null);
		};
		document.head.append(script);
	});
	return loading;
}

export function renderTurnstile(container: HTMLElement, siteKey: string): TurnstileHandle {
	let widgetId: string | null = null;
	let token: string | null = null;
	let removed = false;

	load().then(api => {
		if (!api || removed) return;
		widgetId = api.render(container, {
			sitekey: siteKey,
			theme: "dark",
			callback: (t: string) => token = t,
			"expired-callback": () => token = null,
			"error-callback": () => token = null
		});
	});

	return {
		token: () => token,
		reset: () => {
			token = null;
			if (widgetId !== null) window.turnstile?.reset(widgetId);
		},
		remove: () => {
			removed = true;
			if (widgetId !== null) window.turnstile?.remove(widgetId);
			container.replaceChildren();
		}
	};
}
