import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before React and the app load.
const { waitFor } = await import("@testing-library/react");
const { json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

// #245: an account with no family goes to onboarding instead of an empty Family screen.
test("sends an account with no family to the welcome screen", async () => {
	signIn();
	serve({ "GET /api/families": { families: [] } });
	const { router } = renderRoute("/family");
	expect(await screen.findByRole("region", { name: "Welcome" })).toBeTruthy();
	await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
});

test("reports an unavailable family list", async () => {
	signIn();
	serve({
		"GET /api/families": json(503, {
			error: "unavailable",
			message: "Database is down.",
		}),
	});
	renderRoute("/family");
	expect(await screen.findByText("Your family unavailable")).toBeTruthy();
	expect(screen.getByText("Database is down.")).toBeTruthy();
});
