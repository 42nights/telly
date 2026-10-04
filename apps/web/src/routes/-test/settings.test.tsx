import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before the app loads.
const { fireEvent, within } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

// #254: each setting is its own tab of the Settings screen.
test("shows the phone, speaker, going out, saved things, report email, device, and family settings as tabs in that order", async () => {
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
		["Going out", "/settings/going-out"],
		["Saved things", "/settings/things"],
		["Report email", "/settings/reports"],
		["This device", "/settings/device"],
		["Family", "/settings/family"],
	]);

	for (const [tab, heading] of [
		["Home speaker", "Settings · Home speaker (simulated)"],
		["Going out", "Settings · Going out"],
		["Saved things", "Settings · Saved things"],
		["Report email", "Settings · Report email"],
		["This device", "Settings · This device"],
		["Family", "Settings · Family"],
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

// #316: members show by the name they signed in with; Invite someone makes a join link.
test("Settings › Family lists the members by name and makes a join link", async () => {
	const [me, other, unnamed] = ["a", "b", "c"].map((c) => c.repeat(64));
	signIn();
	const calls = serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/me": {
			issuer: "https://issuer.test",
			subject: "user-1",
			identity: me,
			name: "Ana Lin",
			givenName: null,
			email: null,
			picture: null,
		},
		"GET /api/families/fam-1/members": {
			members: [
				{ identity: me, name: "Ana Lin" },
				{ identity: other, name: "Ben Okafor" },
				{ identity: unnamed, name: null },
			],
		},
		"POST /api/families/fam-1/invites": json(201, {
			code: "c0de",
			expiresAt: "2026-10-11T00:00:00.000Z",
		}),
	});
	renderRoute("/settings/family");
	const list = await screen.findByRole("list", { name: "Family members" });
	await within(list).findByText("Ana Lin (you)");
	expect(
		within(list)
			.getAllByRole("listitem")
			.map((item) => item.textContent),
	).toEqual(["Ana Lin (you)", "Ben Okafor", "Member cccccc"]);
	fireEvent.click(screen.getByRole("button", { name: "Invite someone" }));
	expect(await screen.findByText(`${location.origin}/join/c0de`)).toBeTruthy();
	expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
});
