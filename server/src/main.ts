import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { config } from "./config";
import { initDB } from "./db";

await initDB();

const server = serve({ fetch: createApp().fetch, port: config.port, hostname: "127.0.0.1" }, info => {
	console.log(`kawakaze listening on http://127.0.0.1:${info.port} (public url ${config.publicUrl})`);
});

function shutdown() {
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
