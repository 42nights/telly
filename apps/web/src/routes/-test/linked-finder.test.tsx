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
	sightings: [
		{
			id: "1",
			container: "Lisinopril bottle",
			category: "medicine",
			place: "kitchen counter",
			seenAt: "2026-10-04T12:00:00Z",
			notFoundAt: "2026-10-04T13:00:00Z",
		},
		{
			id: "2",
			container: "House keys",
			category: "keys",
			place: "hall table",
			seenAt: "2026-10-04T11:00:00Z",
			notFoundAt: null,
		},
	],
};

test("a finder link opens once without sign-in and lists places, the asked thing first", async () => {
	const token = "a".repeat(43);
	const path = `/find?person=fam-1&member=${"c".repeat(64)}&object=2&token=${token}&q=keys`;
	const calls = serve({ [OPEN]: finder });
	const { router } = renderRoute(path);

	expect(await screen.findByText("Lisinopril bottle")).toBeTruthy();
	expect(screen.getByText("kitchen counter")).toBeTruthy();
	expect(screen.getByText("Not there when last checked")).toBeTruthy();
	const rows = screen.getAllByRole("listitem");
	expect(rows[0]?.textContent).toStartWith("You asked about thisHouse keys");
	expect(rows[1]?.textContent).not.toContain("You asked about this");
	const opens = calls.filter((c) => `${c.method} ${c.path}` === OPEN);
	expect(opens).toHaveLength(1);
	expect(opens[0]?.body).toEqual({ token });
	expect(opens[0]?.headers.has("Authorization")).toBe(false);
	expect(router.state.location.pathname).toBe("/find");
	// The bare layout: no family list, which needs sign-in.
	expect(calls.some((c) => c.path.startsWith("/api/families"))).toBe(false);
});

test("a used or expired link goes to sign-in, which returns to the finder", async () => {
	serve({
		[OPEN]: json(401, { error: "unauthorized", message: "Link expired." }),
	});
	const member = "c".repeat(64);
	const { router } = renderRoute(
		`/find?person=fam-1&member=${member}&object=2&token=${"b".repeat(43)}`,
	);

	await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
	expect(router.state.location.search).toMatchObject({
		redirect: `/find?person=fam-1&member=${member}&object=2`,
	});
});
