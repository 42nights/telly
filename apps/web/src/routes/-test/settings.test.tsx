import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before the app loads.
const { fireEvent, within } = await import("@testing-library/react");
const { renderRoute, screen, serve, signIn } = await import("@/lib/test/app");

// #254: each setting is its own tab of the Settings screen.
test("shows the phone, speaker, medicine place, report email, device, and delete family settings as tabs in that order", async () => {
	signIn();
	serve({});
	renderRoute("/settings");
	await screen.findByRole("heading", { name: "Settings · Phone numbers" });
	const tabs = within(
		screen.getByRole("navigation", { name: "Settings pages" }),
	).getAllByRole("link");
	expect(tabs.map((t) => [t.textContent, t.getAttribute("href")])).toEqual([
		["Phone numbers", "/settings"],
		["Home speaker", "/settings/speaker"],
		["Things and places", "/settings/places"],
		["Report email", "/settings/reports"],
		["This device", "/settings/device"],
		["Delete family", "/settings/family"],
	]);

	for (const [tab, heading] of [
		["Home speaker", "Settings · Home speaker (simulated)"],
		["Things and places", "Settings · Things and places"],
		["Report email", "Settings · Report email"],
		["This device", "Settings · This device"],
		["Delete family", "Settings · Delete family"],
	] as const) {
		fireEvent.click(
			within(
				screen.getByRole("navigation", { name: "Settings pages" }),
			).getByRole("link", { name: tab }),
		);
		expect(
			await screen.findByRole("heading", { name: heading, level: 2 }),
		).toBeTruthy();
	}
});
