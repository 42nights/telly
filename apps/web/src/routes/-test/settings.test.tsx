import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before the app loads.
const { renderRoute, screen, serve, signIn } = await import("@/lib/test/app");

test("shows the phone, speaker, and medicine place settings in that order", async () => {
	signIn();
	serve({});
	renderRoute("/settings");
	await screen.findByRole("heading", { name: "Settings · Phone numbers" });
	expect(
		screen
			.getAllByRole("heading", { level: 2 })
			.map((h) => h.textContent)
			.filter((t) => t?.startsWith("Settings")),
	).toEqual([
		"Settings · Phone numbers",
		"Settings · Home speaker (simulated)",
		"Settings · Medicine places",
	]);
});
