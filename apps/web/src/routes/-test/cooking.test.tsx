import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: dom must register `document` and mock `@/env` before react-dom and the app load.
const { fireEvent, waitFor } = await import("@testing-library/react");
const { FAMILY, json, renderRoute, screen, serve, signIn } = await import(
	"@/lib/test/app"
);

const SUGGEST = "/api/families/fam-1/cooking/suggestions";

const toast = {
	id: "toast",
	name: "Toast with butter",
	ingredients: [
		{ name: "bread", optional: false, have: true, packaged: true },
		{ name: "butter", optional: false, have: false, packaged: false },
		{ name: "jam", optional: true, have: false, packaged: false },
	],
	steps: [
		{
			text: "Put bread in the toaster.",
			explain: "Two slices.",
			task: "toaster",
			helper: true,
		},
		{
			text: "Spread the butter.",
			explain: "Use a blunt knife.",
			task: null,
			helper: false,
		},
	],
};
const eggs = {
	id: "eggs",
	name: "Boiled eggs",
	ingredients: [{ name: "eggs", optional: false, have: true, packaged: false }],
	steps: [
		{
			text: "Boil the eggs.",
			explain: "Ten minutes.",
			task: "stove",
			helper: false,
		},
	],
};

const withFamily = (routes: Record<string, unknown>) =>
	serve({ "GET /api/families": { families: [FAMILY] }, ...routes });

type Calls = ReturnType<typeof serve>;
const posts = (calls: Calls) => calls.filter((call) => call.method === "POST");

/**
 * Presses Find meals until the request goes out. The family list loads after the first render and
 * the screen shows no sign of it, so an early press only says that the family is still loading.
 */
const ask = async (calls: Calls) => {
	const sent = posts(calls).length;
	const button = await findMeals();
	await waitFor(() => {
		fireEvent.click(button);
		expect(posts(calls)).toHaveLength(sent + 1);
	});
};

const findMeals = async () =>
	(await screen.findByRole("button", {
		name: "Find meals",
	})) as HTMLButtonElement;

test("sends the cleaned food lists and shows notices, instructions and meals", async () => {
	signIn();
	const calls = withFamily({
		[`POST ${SUGGEST}`]: {
			suggestions: [toast, eggs],
			notices: ["No allergy list is saved."],
			instructions: [
				{ name: "Dr. Lee", instruction: "Low salt.", verified: true },
				{ name: "Sam", instruction: "No grapefruit.", verified: false },
			],
		},
	});
	renderRoute("/cooking");
	fireEvent.change(await screen.findByLabelText("What food do you have?"), {
		target: { value: " eggs, bread\nmilk ,, \n" },
	});
	fireEvent.change(
		screen.getByLabelText("Anything you don't want today? (optional)"),
		{
			target: { value: "cheese" },
		},
	);
	await ask(calls);

	expect(await screen.findByText("Before you choose")).toBeTruthy();
	const [post] = posts(calls);
	expect(post?.path).toBe(SUGGEST);
	expect(post?.body).toEqual({
		available: ["eggs", "bread", "milk"],
		avoid: ["cheese"],
	});
	expect(screen.getByText("No allergy list is saved.")).toBeTruthy();
	expect(screen.getByText("Your care instructions about food")).toBeTruthy();
	const items = screen.getAllByRole("listitem").map((li) => li.textContent);
	expect(items).toContain("Dr. Lee: “Low salt.”");
	expect(items).toContain(
		"Sam: “No grapefruit.” (not verified, ask your caregiver)",
	);
	expect(
		screen.getByText(
			"You also need: butter. 1 of 2 steps need a helper with you.",
		),
	).toBeTruthy();
	expect(screen.getByText("You have everything you need.")).toBeTruthy();
});

test("Start opens the meal one step at a time, and stopping returns to the meal list form", async () => {
	signIn();
	const calls = withFamily({
		[`POST ${SUGGEST}`]: { suggestions: [eggs], notices: [], instructions: [] },
	});
	renderRoute("/cooking");
	await ask(calls);
	expect(await screen.findByRole("button", { name: "Start" })).toBeTruthy();
	expect(screen.queryByText("Before you choose")).toBeNull();
	expect(screen.queryByText("Your care instructions about food")).toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "Start" }));
	expect(await screen.findByText("Boiled eggs · Step 1 of 1")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Find meals" })).toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "Stop" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Choose another meal" }),
	);

	expect(await findMeals()).toBeTruthy();
	expect(screen.getByLabelText("What food do you have?")).toBeTruthy();
});

test("no fitting meal tells the person to ask for help choosing", async () => {
	signIn();
	const calls = withFamily({
		[`POST ${SUGGEST}`]: { suggestions: [], notices: [], instructions: [] },
	});
	renderRoute("/cooking");
	await ask(calls);
	expect(
		await screen.findByText(
			"No meal here fits your needs. Ask your caregiver or a family member to help you choose.",
		),
	).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
});

test("the button is disabled while the request is in flight", async () => {
	signIn();
	const reply = Promise.withResolvers<Response>();
	const calls = withFamily({ [`POST ${SUGGEST}`]: () => reply.promise });
	renderRoute("/cooking");
	await ask(calls);
	const button = await findMeals();
	expect(button.disabled).toBe(true);

	reply.resolve(json(200, { suggestions: [], notices: [], instructions: [] }));
	await waitFor(() => expect(button.disabled).toBe(false));
	expect(screen.getByText(/^No meal here fits your needs/)).toBeTruthy();
});

test("with no paired person it asks for nothing and says why", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [] } });
	renderRoute("/cooking");
	const button = await findMeals();

	await waitFor(() => {
		fireEvent.click(button);
		expect(screen.getByText("No person is paired yet.")).toBeTruthy();
	});
	expect(screen.getByText("Could not load meal ideas")).toBeTruthy();
	expect(posts(calls)).toEqual([]);
});

test("a press before the family list arrives says it is still loading", async () => {
	signIn();
	const calls = serve({
		"GET /api/families": () => Promise.withResolvers().promise,
	});
	renderRoute("/cooking");

	fireEvent.click(await findMeals());

	expect(
		await screen.findByText(
			"Your family is still loading. Try again in a moment.",
		),
	).toBeTruthy();
	expect(screen.queryByText("No person is paired yet.")).toBeNull();
	expect(posts(calls)).toEqual([]);
});

test("an unavailable family list (503) shows its reason on a press", async () => {
	signIn();
	const calls = serve({
		"GET /api/families": json(503, {
			error: "unavailable",
			message: "Database is down.",
		}),
	});
	renderRoute("/cooking");
	const button = await findMeals();

	await waitFor(() => {
		fireEvent.click(button);
		expect(screen.getByText("Database is down.")).toBeTruthy();
	});
	expect(screen.getByText("Meal ideas unavailable")).toBeTruthy();
	expect(screen.queryByText("No person is paired yet.")).toBeNull();
	expect(posts(calls)).toEqual([]);
});

test("an unavailable provider (503) shows that meal ideas are unavailable", async () => {
	signIn();
	const calls = withFamily({
		[`POST ${SUGGEST}`]: json(503, {
			error: "unavailable",
			message: "Gemini is overloaded.",
		}),
	});
	renderRoute("/cooking");
	await ask(calls);
	expect(await screen.findByText("Meal ideas unavailable")).toBeTruthy();
	expect(screen.getByText("Gemini is overloaded.")).toBeTruthy();
	expect(screen.getByRole("alert")).toBeTruthy();
});

test("a 403 says the person is not a member", async () => {
	signIn();
	const calls = withFamily({
		[`POST ${SUGGEST}`]: json(403, {
			error: "forbidden",
			message: "Not yours.",
		}),
	});
	renderRoute("/cooking");
	await ask(calls);
	expect(await screen.findByText("Not a member of this family")).toBeTruthy();
	expect(screen.getByText("Not yours.")).toBeTruthy();
});

test("a malformed reply or a lost network shows an error, never meals", async () => {
	signIn();
	let replies = 0;
	const calls = withFamily({
		[`POST ${SUGGEST}`]: () => {
			if (++replies === 1) return { suggestions: "none" };
			throw new TypeError("Failed to fetch");
		},
	});
	renderRoute("/cooking");
	await ask(calls);
	expect(
		await screen.findByText(/^The server sent an unexpected reply/),
	).toBeTruthy();
	expect(screen.getByText("Could not load meal ideas")).toBeTruthy();

	await ask(calls);
	expect(
		await screen.findByText(
			"The server is not reachable: TypeError: Failed to fetch",
		),
	).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
});
