import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: dom.ts must register `document` and mock `@/env` before react-dom and the app load.
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
	expect(calls.map((call) => call.path)).toEqual([
		"/api/families",
		"/api/families/fam-1/appointments",
	]);
});

test("when visits cannot load, says why", async () => {
	signIn();
	serve({
		"GET /api/families": { families: [FAMILY] },
		"GET /api/families/fam-1/appointments": json(403, {
			error: "forbidden",
			message: "Not a member of this family.",
		}),
	});
	renderRoute("/appointments");

	expect(await screen.findByText("Not a member of this family.")).toBeTruthy();
	expect(screen.queryByText("No upcoming visits recorded.")).toBeNull();
});

test("with no paired person, says so and reads no visits", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [] } });
	renderRoute("/appointments");

	expect(await screen.findByText("No person is paired yet.")).toBeTruthy();
	expect(calls.map((call) => call.path)).toEqual(["/api/families"]);
});
