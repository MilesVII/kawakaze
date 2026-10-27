/** Fixed-window counters kept in memory; good enough for one process */
export function rateLimiter(limit: number, windowMs: number) {
	const windows = new Map<string, { start: number, count: number }>();

	setInterval(() => {
		const now = Date.now();
		for (const [key, w] of windows)
			if (now - w.start > windowMs) windows.delete(key);
	}, windowMs).unref();

	/** true when the action is allowed (and counted) */
	return (key: string) => {
		const now = Date.now();
		const w = windows.get(key);
		if (!w || now - w.start > windowMs) {
			windows.set(key, { start: now, count: 1 });
			return true;
		}
		if (w.count >= limit) return false;
		w.count++;
		return true;
	};
}
