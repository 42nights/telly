import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: dom.ts must register `document` and mock `@/env` before react-dom and the app load.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

test("with no reports, offers to create one and says why creating failed", async () => {
	signIn();
	const calls = serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1/reports": { reports: [] },
		"POST /api/families/fam-1/reports": json(503, {
			error: "unavailable",
			message: "Database is not reachable.",
		}),
	});
	renderRoute("/reports");

	expect(
		await screen.findByText(
			"No reports yet. A new report collects the latest reading of each measure saved for Grandma Rose.",
		),
	).toBeTruthy();
	expect(screen.getByText("No reports yet")).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "New report" }));
	expect(await screen.findByText("Database is not reachable.")).toBeTruthy();
	expect(
		calls.filter((call) => call.method === "POST").map((call) => call.path),
	).toEqual(["/api/families/fam-1/reports"]);
	await waitFor(() =>
		expect(
			screen
				.getByRole("button", { name: "New report" })
				.hasAttribute("disabled"),
		).toBe(false),
	);
});

test("with no paired person, says so and reads no reports", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [] } });
	renderRoute("/reports");

	expect(await screen.findByText("No person is paired yet.")).toBeTruthy();
	expect(calls.map((call) => call.path)).toEqual(["/api/families"]);
});

test("signed out, asks the person to sign in and fetches nothing", async () => {
	const calls = serve({});
	renderRoute("/reports");

	expect(
		await screen.findByText("Sign in to see reports.", { exact: false }),
	).toBeTruthy();
	expect(screen.getByRole("link", { name: "Go to Sign in" })).toBeTruthy();
	expect(calls).toEqual([]);
});
