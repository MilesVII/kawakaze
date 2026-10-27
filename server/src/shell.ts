import fs from "node:fs";
import path from "node:path";
import type { BootPayload } from "@shared/api";
import { homePage, siteStats } from "./catalog";
import { config, oauthProviders } from "./config";
import { db } from "./db";
import { mediaUrl } from "./media";
import { publicUser } from "./routes/users";

/*
SPA shell: web/index.html with `<!--kawa-head-->` replaced by OG tags and the boot payload.
The file is read once in production and on every request in dev, so frontend rebuilds show up immediately.
*/

const SITE = "Kawakaze";
const DEFAULT_DESCRIPTION = "Community scenario cards for LLM roleplay. Play locally with your own provider.";
const MARKER = "<!--kawa-head-->";

let cached: string | null = null;
function template() {
	if (cached && !config.serveStatic) return cached;
	cached = fs.readFileSync(path.join(config.webDir, "index.html"), "utf8");
	return cached;
}

function attr(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
function clip(value: string, length: number) {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

type Head = { title: string | null, description: string, image: string | null, url: string };

async function headFor(pathname: string): Promise<Head> {
	const url = `${config.publicUrl}${pathname}`;
	const head: Head = { title: null, description: DEFAULT_DESCRIPTION, image: null, url };

	const scenario = pathname.match(/^\/c\/([a-zA-Z0-9_-]{1,64})\/?$/);
	if (scenario) {
		const row = await db
			.selectFrom("scenarios")
			.select(["title", "snippet", "card_picture", "delisted_at"])
			.where("id", "=", scenario[1])
			.executeTakeFirst();
		if (row && !row.delisted_at) {
			head.title = row.title;
			head.description = clip(row.snippet, 300) || DEFAULT_DESCRIPTION;
			head.image = mediaUrl(row.card_picture);
		}
	}

	const user = pathname.match(/^\/u\/([^/]{1,64})\/?$/);
	if (user) {
		const found = await publicUser(decodeURIComponent(user[1])).catch(() => null);
		if (found) {
			head.title = found.user.username;
			head.description = clip(found.user.bio, 300) || `${found.user.username} on ${SITE}`;
			head.image = found.user.icon;
		}
	}
	return head;
}

export async function renderShell(pathname: string) {
	const head = await headFor(pathname);
	const boot: BootPayload = {
		config: {
			publicUrl: config.publicUrl,
			turnstileSiteKey: config.turnstile.secret ? config.turnstile.siteKey : "",
			oauth: oauthProviders()
		}
	};
	if (pathname === "/") {
		boot.home = await homePage();
		boot.stats = await siteStats();
	}

	const fullTitle = head.title ? `${head.title} | ${SITE}` : SITE;
	const tags = [
		`<meta name="description" content="${attr(head.description)}">`,
		`<meta property="og:site_name" content="${SITE}">`,
		`<meta property="og:type" content="website">`,
		`<meta property="og:title" content="${attr(head.title ?? SITE)}">`,
		`<meta property="og:description" content="${attr(head.description)}">`,
		`<meta property="og:url" content="${attr(head.url)}">`,
		head.image ? `<meta property="og:image" content="${attr(head.image)}">` : "",
		`<meta name="twitter:card" content="${head.image ? "summary_large_image" : "summary"}">`,
		`<script id="kawa-boot" type="application/json">${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>`
	].filter(t => t).join("\n\t\t");

	let html = template();
	html = html.includes(MARKER) ? html.replace(MARKER, tags) : html.replace("</head>", `${tags}\n</head>`);
	if (head.title) html = html.replace("<title>Kawakaze</title>", `<title>${attr(fullTitle)}</title>`);
	return html;
}
