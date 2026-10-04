import { expect, spyOn, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Static imports load before `setupDom` registers `document` and mocks `@/env`.
const { fireEvent, render, waitFor } = await import("@testing-library/react");
const { FAMILY, json, screen, serve, signIn } = await import("@/lib/test/app");
const { FamilyProvider, PersonPicker, useFamily } = await import("./family");

const OTHER = { ...FAMILY, id: "fam-2", name: "Grandpa Joe" };

function Shown() {
	const { family, state } = useFamily();
	return (
		<p>
			Shown: {family?.name ?? "none"} ({state.kind})
		</p>
	);
}

const show = () =>
	render(
		<FamilyProvider>
			<PersonPicker className="extra" />
			<Shown />
		</FamilyProvider>,
	);

const picker = () =>
	screen.getByRole<HTMLSelectElement>("combobox", { name: "Person" });

test("selects the remembered family while it is still listed", async () => {
	signIn();
	localStorage.setItem("telly.family", "fam-2");
	serve({ "GET /api/families": { families: [FAMILY, OTHER] } });
	show();
	expect(await screen.findByText("Shown: Grandpa Joe (ready)")).toBeTruthy();
	expect(picker().value).toBe("fam-2");
	expect(picker().disabled).toBe(false);
});

test("falls back to the first family when the remembered one is gone", async () => {
	signIn();
	localStorage.setItem("telly.family", "fam-gone");
	serve({ "GET /api/families": { families: [FAMILY, OTHER] } });
	show();
	expect(await screen.findByText("Shown: Grandma Rose (ready)")).toBeTruthy();
	expect(picker().value).toBe("fam-1");
	expect(
		screen.getAllByRole("option").map((option) => option.textContent),
	).toEqual([
		"Grandma Rose",
		"Grandpa Joe",
		"Add a person — manual pairing only",
	]);
	expect(
		screen.getByRole<HTMLOptionElement>("option", {
			name: "Add a person — manual pairing only",
		}).disabled,
	).toBe(true);
});

test("choosing a person shows them and remembers the choice on this device", async () => {
	signIn();
	serve({ "GET /api/families": { families: [FAMILY, OTHER] } });
	show();
	await screen.findByText("Shown: Grandma Rose (ready)");
	fireEvent.change(picker(), { target: { value: "fam-2" } });
	expect(await screen.findByText("Shown: Grandpa Joe (ready)")).toBeTruthy();
	expect(picker().value).toBe("fam-2");
	expect(localStorage.getItem("telly.family")).toBe("fam-2");
});

test("with no family the picker says so and is disabled", async () => {
	signIn();
	serve({ "GET /api/families": { families: [] } });
	show();
	expect(await screen.findByText("Shown: none (ready)")).toBeTruthy();
	expect(picker().disabled).toBe(true);
	expect(picker().value).toBe("");
	expect(screen.getByRole("option", { name: "No person yet" })).toBeTruthy();
});

test("while loading and on failure no family is selected", async () => {
	signIn();
	serve({
		"GET /api/families": json(503, {
			error: "unavailable",
			message: "DB down",
		}),
	});
	show();
	expect(screen.getByText("Shown: none (loading)")).toBeTruthy();
	expect(picker().disabled).toBe(true);
	await waitFor(() =>
		expect(screen.getByText("Shown: none (unavailable)")).toBeTruthy(),
	);
	expect(screen.getByRole("option", { name: "No person yet" })).toBeTruthy();
});

test("signed out, no family is selected and nothing is fetched", async () => {
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	show();
	expect(await screen.findByText("Shown: none (signed_out)")).toBeTruthy();
	expect(calls).toEqual([]);
});

test("useFamily outside FamilyProvider fails loudly", () => {
	// React reports the render error on the console as well; keep the output clean.
	const consoleError = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(() => render(<Shown />)).toThrow(
			"useFamily must be used inside FamilyProvider",
		);
	} finally {
		consoleError.mockRestore();
	}
});
