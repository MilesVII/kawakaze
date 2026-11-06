import { api } from "@root/api";
import { toast } from "@units/toasts";

/*
Uncaught errors and unhandled rejections show a toast; its "report" action sends the error to the server,
where admins see it in the admin panel (server/src/errors.ts). Each distinct error (message and stack) gets one toast
per page load, and only the first few do, so an error thrown in a loop doesn't bury the page.
*/

type ErrorReport = Pick<ErrorEvent, "message" | "lineno" | "filename"> & { stack?: string };

const MAX_TOASTS = 5;
const SHOWN_CHARS = 200;
/** errors already shown from this page load */
const seen = new Set<string>();

export function addError(e: ErrorReport) {
	const message = e.stack
		? e.message
		: `${e.filename}:${e.lineno} ${e.message}`;
	const key = `${message}\n${e.stack ?? ""}`;
	if (seen.has(key) || seen.size >= MAX_TOASTS) return;
	seen.add(key);

	const shown = message.length > SHOWN_CHARS ? `${message.slice(0, SHOWN_CHARS)}…` : message;
	// errors from scripts of other origins come without any detail, there's nothing to report
	const reportable = !(message.endsWith("Script error.") && !e.stack);
	const actions: [string, (close: () => void) => void][] = [["dismiss", close => close()]];
	if (reportable) actions.unshift(["report", close => {
		close();
		report(message, e.stack);
	}]);
	toast(`Something went wrong: ${shown}`, { actions });
}

/** sends the error to the server for the admin panel */
async function report(message: string, stack?: string) {
	const r = await api("POST", "/api/errors", { message, stack, url: location.pathname });
	toast(r.success ? "reported, thanks" : `can't send the report: ${r.error}`, { timeoutMS: 3000 });
}

export function init() {
	window.addEventListener("error", e => addError({
		message: e.message,
		filename: e.filename,
		lineno: e.lineno,
		stack: e.error instanceof Error ? e.error.stack : undefined
	}));
	window.addEventListener("unhandledrejection", e => {
		// Anything can be thrown, not only Errors.
		const reason = e.reason;
		addError({
			filename: "",
			lineno: 0,
			message: reason instanceof Error ? reason.message : String(reason),
			stack: reason instanceof Error ? reason.stack : undefined
		});
	});
}
