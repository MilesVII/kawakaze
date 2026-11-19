import { createAdaptorServer } from "@hono/node-server";
import { createApp } from "./app";
import { config } from "./config";
import { initDB } from "./db";

await initDB();

const server = createAdaptorServer({ fetch: createApp().fetch });

// Under systemd socket activation (deploy/kawakaze.socket) systemd owns the listening socket and passes it as fd 3.
// It stays open while the service restarts, so connections made in between wait for the new process instead of
// getting refused (nginx's 502).
const socketActivated = process.env.LISTEN_FDS === "1" && Number(process.env.LISTEN_PID) === process.pid;
const where = socketActivated ? "the systemd socket" : `http://127.0.0.1:${config.port}`;
const listening = () => console.log(`kawakaze listening on ${where} (public url ${config.publicUrl})`);
if (socketActivated)
	server.listen({ fd: 3 }, listening);
else
	server.listen(config.port, "127.0.0.1", listening);

function shutdown() {
	// stops accepting and lets requests in flight finish; under socket activation systemd keeps the socket itself
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
