import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `dom` must register `document` and mock `@/env` before React and the app load.
const { waitFor } = await import("@testing-library/react");
const { json, renderRoute, screen, serve } = await import("@/lib/test/app");

const OPEN = "POST /api/finder-link/open";
const finder = {
	session: "s".repeat(43),
	expiresAt: "2026-10-04T15:15:00Z",
	remembering: true,
	sightings: [
		{
			id: "1",
			container: "Lisinopril bottle",
			place: "kitchen counter",
			seenAt: "2026-10-04T12:00:00Z",
			notFoundAt: "2026-10-04T13:00:00Z",
		},
	],
};

test("a finder link opens once without sign-in and lists places", async () => {
	const token = "a".repeat(43);
	const path = `/medicine?person=fam-1&link=${token}&q=pills`;
	const calls = serve({ [OPEN]: finder });
	const { router } = renderRoute(path);

	expect(await screen.findByText("Lisinopril bottle")).toBeTruthy();
	expect(screen.getByText("kitchen counter")).toBeTruthy();
	expect(screen.getByText("Not there when last checked")).toBeTruthy();
	const opens = calls.filter((c) => `${c.method} ${c.path}` === OPEN);
	expect(opens).toHaveLength(1);
	expect(opens[0]?.body).toEqual({ token });
	expect(opens[0]?.headers.has("Authorization")).toBe(false);
	expect(router.state.location.pathname).toBe("/medicine");
	// The bare layout: no family list, which needs sign-in.
	expect(calls.some((c) => c.path.startsWith("/api/families"))).toBe(false);
});

test("a used or expired link goes to sign-in, which returns to the finder", async () => {
	serve({
		[OPEN]: json(401, { error: "unauthorized", message: "Link expired." }),
	});
	const { router } = renderRoute(
		`/medicine?person=fam-1&link=${"b".repeat(43)}`,
	);

	await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
	expect(router.state.location.search).toMatchObject({
		redirect: "/medicine?person=fam-1",
	});
});
