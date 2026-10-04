import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: `dom` must register `document` and mock `@/env` before these modules load.
const { waitFor } = await import("@testing-library/react");
const { FAMILY, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

test("/ redirects to the HUD inside the app layout with its head tags", async () => {
	signIn();
	serve({ "GET /api/families": { families: [FAMILY] } });
	const { router } = renderRoute("/");
	await waitFor(() => expect(router.state.location.pathname).toBe("/hud"));
	expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
	await waitFor(() => expect(document.title).toBe("Health HUD"));
	expect(
		document.querySelector('meta[name="description"]')?.getAttribute("content"),
	).toBe("Health HUD and family dashboard");
	expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(
		"/favicon.ico",
	);
});
