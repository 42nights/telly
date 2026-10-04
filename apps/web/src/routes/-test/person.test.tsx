import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Dynamic: `setupDom()` must register `document` and mock `@/env` before React and the app load.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const OTHER = { ...FAMILY, id: "fam-2", name: "Grandpa Joe" };

test("the address picks this tab's person over the device default, and screens keep it", async () => {
	signIn();
	localStorage.setItem("telly.family", "fam-1");
	serve({ "GET /api/families": { families: [FAMILY, OTHER] } });
	const { router } = renderRoute("/family/trends?person=fam-2");

	expect(
		await screen.findByRole("heading", { name: "Grandpa Joe" }),
	).toBeTruthy();

	fireEvent.change(
		screen.getByRole<HTMLSelectElement>("combobox", { name: "Person" }),
		{ target: { value: "fam-1" } },
	);
	expect(
		await screen.findByRole("heading", { name: "Grandma Rose" }),
	).toBeTruthy();
	await waitFor(() =>
		expect(router.state.location.search).toEqual({ person: "fam-1" }),
	);

	await router.navigate({ to: "/family" });
	expect(router.state.location.search).toEqual({ person: "fam-1" });
});
