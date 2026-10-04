import { expect, spyOn, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Static imports load before `setupDom` registers `document` and mocks `@/env`.
const { fireEvent, render, waitFor } = await import("@testing-library/react");
const { FAMILY, json, screen, serve, signIn } = await import("@/lib/test/app");
const { chooseFamily, FamilyProvider, PersonPicker, useFamily } = await import(
	"./family"
);

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
	).toEqual(["Grandma Rose", "Grandpa Joe", "Add a person…"]);
	// #245: "Add a person…" opens onboarding, so it is no longer disabled.
	expect(
		screen.getByRole<HTMLOptionElement>("option", { name: "Add a person…" })
			.disabled,
	).toBe(false);
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

// #245: with no family the picker still offers "Add a person…" for onboarding.
test("with no family the picker says so and offers to add a person", async () => {
	signIn();
	serve({ "GET /api/families": { families: [] } });
	show();
	expect(await screen.findByText("Shown: none (ready)")).toBeTruthy();
	expect(picker().disabled).toBe(false);
	expect(
		screen.getAllByRole("option").map((option) => option.textContent),
	).toEqual(["No person yet", "Add a person…"]);
	expect(picker().value).toBe("");
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
	expect(picker().value).toBe("");
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

test("a member opens the family with the newest real data, not an empty remembered one", () => {
	const at = (id: string, newestSampleAt: string | null) => ({
		...FAMILY,
		id,
		newestSampleAt,
	});
	const empty = at("1", null);
	const old = at("2", "2026-10-03T08:00:00Z");
	const live = at("3", "2026-10-04T08:00:00Z");
	expect(chooseFamily([empty, old, live], null, null)).toBe(live);
	expect(chooseFamily([empty, old, live], null, "1")).toBe(live);
	expect(chooseFamily([empty, old, live], null, "2")).toBe(old);
	expect(chooseFamily([empty, live], "1", "1")).toBe(empty);
	expect(chooseFamily([empty, at("4", null)], null, "4")?.id).toBe("4");
	expect(chooseFamily([empty, at("4", null)], null, null)).toBe(empty);
	expect(chooseFamily([], null, "1")).toBeNull();
});
