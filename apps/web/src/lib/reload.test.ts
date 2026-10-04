import { expect, test } from "bun:test";

import { reloadOnce } from "./reload";

test("a failed chunk reloads once, then again only after the guard window", () => {
	const items = new Map<string, string>();
	const storage = {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
	};
	let reloads = 0;
	const reload = () => reloads++;

	expect(reloadOnce(storage, reload, 1_000_000)).toBe(true);
	// The reloaded page fails again at once: a real error, not a stale build.
	expect(reloadOnce(storage, reload, 1_005_000)).toBe(false);
	expect(reloads).toBe(1);
	// A later deploy in the same tab reloads again.
	expect(reloadOnce(storage, reload, 1_011_000)).toBe(true);
	expect(reloads).toBe(2);
});
