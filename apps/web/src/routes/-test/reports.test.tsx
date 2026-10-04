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

// #245: an account with no person goes to onboarding, so no report is read.
test("with no paired person, goes to the welcome screen and reads no reports", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [] } });
	const { router } = renderRoute("/reports");

	expect(await screen.findByRole("region", { name: "Welcome" })).toBeTruthy();
	await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
	expect(calls.some((call) => call.path.includes("/reports"))).toBe(false);
});
