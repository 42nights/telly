import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: dom.ts must register `document` and mock `@/env` before react-dom and the app load.
const { waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

test("with no visits, says none are upcoming and offers a new one", async () => {
	signIn();
	const calls = serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1/appointments": { appointments: [] },
	});
	renderRoute("/appointments");

	expect(await screen.findByText("No upcoming visits recorded.")).toBeTruthy();
	expect(screen.queryByText("Past and cancelled")).toBeNull();
	// The frame's status bar reads /health, /api/sources, and monitoring on every page.
	const status = ["/health", "/api/sources", "/api/families/fam-1/monitoring"];
	expect(
		calls.map((call) => call.path).filter((path) => !status.includes(path)),
	).toEqual(["/api/families", "/api/families/fam-1/appointments"]);
});

test("when visits cannot load, says why", async () => {
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1/appointments": json(403, {
			error: "forbidden",
			message: "Not shared with you.",
		}),
	});
	renderRoute("/appointments");

	expect(await screen.findByText("Not shared with you")).toBeTruthy();
	expect(screen.queryByText("No upcoming visits recorded.")).toBeNull();
});

test("with no paired person, goes to onboarding and reads no visits", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [] } });
	// An empty family list goes to /welcome (#245); the screen's own notice is in screen.test.tsx.
	const { router } = renderRoute("/appointments");

	await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
	expect(calls.some((call) => call.path.includes("/appointments"))).toBe(false);
});
