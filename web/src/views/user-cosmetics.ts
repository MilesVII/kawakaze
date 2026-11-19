import { UserRef } from "@shared/api";
import { mudcrack } from "rampike";

export function usernameCosmetics(user: UserRef) {
	if (
		!user.cosmetics ||
		!("badge" in user.cosmetics) ||
		!Array.isArray(user.cosmetics.badge)
	) return null;

	const [text, style] = user.cosmetics.badge as string[];
	return {
		badge: mudcrack({
			className: `badge badge-${style}`,
			contents: text
		})
	};
}
