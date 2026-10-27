import { db, initDB } from "./db";
import { issueInvites } from "./routes/admin";
import { findUserByName } from "./users";

const USAGE = [
	"usage:",
	"  cli migrate                 apply database migrations",
	"  cli admin <username>        grant admin (and creator) rights",
	"  cli unadmin <username>      revoke admin rights",
	"  cli invite [count] [note]   issue creator invite tokens"
].join("\n");

async function main(args: string[]) {
	const [command, ...rest] = args;
	await initDB();

	switch (command) {
		case "migrate":
			console.log("database is up to date");
			return 0;
		case "admin":
		case "unadmin": {
			const user = rest[0] ? await findUserByName(rest[0]) : null;
			if (!user) {
				console.error(`user "${rest[0] ?? ""}" not found; they need to sign in once first`);
				return 1;
			}
			const grant = command === "admin";
			await db
				.updateTable("users")
				.set(grant ? { is_admin: 1, is_creator: 1 } : { is_admin: 0 })
				.where("id", "=", user.id)
				.execute();
			console.log(`${user.username}: admin ${grant ? "granted" : "revoked"}`);
			return 0;
		}
		case "invite": {
			const count = parseInt(rest[0] ?? "1", 10);
			if (isNaN(count) || count < 1 || count > 100) {
				console.error("count must be 1-100");
				return 1;
			}
			const tokens = await issueInvites(count, rest.slice(1).join(" "), null);
			console.log(tokens.join("\n"));
			return 0;
		}
		default:
			console.log(USAGE);
			return command ? 1 : 0;
	}
}

process.exitCode = await main(process.argv.slice(2));
await db.destroy();
