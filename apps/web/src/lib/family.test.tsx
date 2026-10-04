import { expect, spyOn, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Static imports load before `setupDom` registers `document` and mocks `@/env`.
const { fireEvent, render, waitFor } = await import("@testing-library/react");
const { FAMILY, json, screen, serve, signIn } = await import("@/lib/test/app");
const { getSessionToken } = await import("./session");
const { FamilyProvider, NewFamilyBar, PersonPicker, useFamily } = await import(
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

const showWithBar = () =>
	render(
		<FamilyProvider>
			<NewFamilyBar />
			<Shown />
		</FamilyProvider>,
	);

const nameField = () =>
	screen.getByLabelText<HTMLInputElement>(
		"You have no family yet. Name it to start:",
	);
const createButton = () =>
	screen.getByRole<HTMLButtonElement>("button", { name: "Create family" });

test("a caller with a family never sees the new-family form", async () => {
	signIn();
	serve({ "GET /api/families": { families: [FAMILY] } });
	showWithBar();
	expect(await screen.findByText("Shown: Grandma Rose (ready)")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Create family" })).toBeNull();
});

test("a new account names its first family, which is then selected and shown", async () => {
	signIn();
	const created = { ...FAMILY, id: "fam-new", name: "Rivera family" };
	let families: (typeof FAMILY)[] = [];
	const reply = Promise.withResolvers<Response>();
	const calls = serve({
		"GET /api/families": () => ({ families }),
		"POST /api/families": () => reply.promise,
	});
	showWithBar();
	await screen.findByText("Shown: none (ready)");
	// A blank or whitespace-only name cannot be sent.
	expect(createButton().disabled).toBe(true);
	fireEvent.change(nameField(), { target: { value: "   " } });
	expect(createButton().disabled).toBe(true);

	fireEvent.change(nameField(), { target: { value: "  Rivera family " } });
	fireEvent.click(createButton());
	expect(
		(
			await screen.findByRole<HTMLButtonElement>("button", {
				name: "Creating…",
			})
		).disabled,
	).toBe(true);
	families = [created];
	reply.resolve(json(201, created));

	expect(await screen.findByText("Shown: Rivera family (ready)")).toBeTruthy();
	expect(
		screen.queryByLabelText("You have no family yet. Name it to start:"),
	).toBeNull();
	expect(localStorage.getItem("telly.family")).toBe("fam-new");
	expect(
		calls.filter((call) => call.method === "POST").map((call) => call.body),
	).toEqual([{ name: "Rivera family" }]);
	expect(
		calls.filter(
			(call) => call.path === "/api/families" && call.method === "GET",
		),
	).toHaveLength(2);
});

test("a refused create keeps the form and says why; a rejected token ends the session", async () => {
	signIn();
	serve({
		"GET /api/families": { families: [] },
		"POST /api/families": json(403, {
			error: "forbidden",
			message: "Accounts are full.",
		}),
	});
	showWithBar();
	await screen.findByText("Shown: none (ready)");
	fireEvent.change(nameField(), { target: { value: "Rivera family" } });
	fireEvent.click(createButton());
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Could not create the family. Accounts are full.",
	);
	expect(nameField().value).toBe("Rivera family");
	expect(createButton().disabled).toBe(false);

	serve({
		"GET /api/families": { families: [] },
		"POST /api/families": json(401, { error: "unauthorized", message: "x" }),
	});
	// A rejected token ends the session; the form goes away and the app shows sign-in.
	fireEvent.click(createButton());
	await waitFor(() =>
		expect(
			screen.queryByRole("button", { name: "Create family" }) === null,
		).toBe(true),
	);
	expect(getSessionToken()).toBeNull();
	expect(screen.getByText("Shown: none (signed_out)")).toBeTruthy();
});
