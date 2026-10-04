// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type { MealSuggestion } from "@health/contracts/cooking";

import {
	fireEvent,
	renderRouted,
	serve,
	setupDom,
	signIn,
	waitFor,
} from "../test/dom-routed";
import { CookingSession } from "./session";

setupDom();

const MESSAGES = "/api/families/f1/messages";

const meal: MealSuggestion = {
	id: "rice",
	name: "Rice",
	ingredients: [{ name: "rice", optional: false, have: true, packaged: true }],
	steps: [
		{
			text: "Wash the rice.",
			explain: "Rinse it under cold water until the water is clear.",
			task: null,
			helper: false,
		},
		{
			text: "Boil the rice.",
			explain: "Cook it for twelve minutes.",
			task: "stove",
			helper: true,
		},
	],
};

const start = async (familyId: string | null = "f1") => {
	let done = 0;
	const { view } = await renderRouted(
		<CookingSession familyId={familyId} meal={meal} onDone={() => done++} />,
	);
	const button = (name: string) =>
		view.getByRole("button", { name }) as HTMLButtonElement;
	return { view, button, done: () => done };
};

test("the wearer walks the steps; a helper step waits until the helper is here, then the meal can be recorded", async () => {
	const { view, button, done } = await start();
	expect(view.getByText("Rice · Step 1 of 2")).toBeDefined();
	expect(view.getByText("Wash the rice.")).toBeDefined();
	expect(view.queryByRole("note")).toBeNull();

	fireEvent.click(button("Explain"));
	expect(view.getByText(/Rinse it under cold water/)).toBeDefined();
	fireEvent.click(button("Hide"));
	expect(view.queryByText(/Rinse it under cold water/)).toBeNull();

	fireEvent.click(button("Next"));
	expect(view.getByText("Rice · Step 2 of 2")).toBeDefined();
	expect(view.getByRole("note").textContent).toContain(
		"This step uses the stove.",
	);
	expect(button("Done").disabled).toBe(true);

	fireEvent.click(button("My helper is here"));
	const here = button("Your helper is here");
	expect(here.getAttribute("aria-pressed")).toBe("true");
	expect(here.disabled).toBe(true);
	expect(button("Done").disabled).toBe(false);

	fireEvent.click(button("Done"));
	expect(view.getByText("You finished Rice.")).toBeDefined();
	const record = view.getByRole("link", { name: "Yes, record it" });
	expect(record.getAttribute("href")).toBe("/meal?dish=Rice");
	fireEvent.click(button("Not now"));
	expect(done()).toBe(1);
});

test("pause holds the step: only Resume and Stop work, and the voice control goes away", async () => {
	const { view, button } = await start();
	fireEvent.click(button("Next"));
	fireEvent.click(button("Pause"));
	expect(view.getByRole("status").textContent).toBe(
		"Paused. Press Resume when you are ready.",
	);
	expect(view.queryByRole("button", { name: "Repeat" })).toBeNull();
	expect(button("Explain").disabled).toBe(true);
	expect(button("My helper is here").disabled).toBe(true);
	expect(button("Done").disabled).toBe(true);

	fireEvent.click(button("Resume"));
	expect(view.queryByText(/Paused/)).toBeNull();
	expect(button("Repeat")).toBeDefined();
	expect(button("Explain").disabled).toBe(false);
	expect(view.getByText("Rice · Step 2 of 2")).toBeDefined();
});

test("after a stop, asking for help sends one family message and shows it as sent", async () => {
	signIn();
	const calls = serve({ [`POST ${MESSAGES}`]: { status: 204 } });
	const { view, button, done } = await start();
	fireEvent.click(button("Stop"));
	expect(view.getByText("You stopped cooking.")).toBeDefined();

	fireEvent.click(button("Ask my family for help"));
	expect((await view.findByRole("status")).textContent).toBe(
		"Your family can see your message in the family chat.",
	);
	expect(button("Help asked").disabled).toBe(true);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.method).toBe("POST");
	expect(calls[0]?.path).toBe(MESSAGES);
	expect(calls[0]?.body).toEqual({
		clientId: expect.any(String),
		body: "I stopped cooking Rice at step 1. Can someone check on me?",
	});

	fireEvent.click(button("Choose another meal"));
	expect(done()).toBe(1);
});

test("on a helper step, a failed help request says so, and the retry reuses the same message id", async () => {
	signIn();
	let failures = 1;
	const calls = serve({
		[`POST ${MESSAGES}`]: () =>
			failures-- > 0
				? {
						status: 503,
						json: { error: "unavailable", message: "Chat is down." },
					}
				: { status: 204 },
	});
	const { view, button } = await start();
	fireEvent.click(button("Next"));
	fireEvent.click(button("Ask my family for help"));
	expect((await view.findByRole("alert")).textContent).toBe(
		"Your family did not get the message. Chat is down.",
	);
	expect(button("Ask my family for help").disabled).toBe(false);

	fireEvent.click(button("Ask my family for help"));
	await view.findByRole("button", { name: "Help asked" });
	expect(view.queryByRole("alert")).toBeNull();
	expect(calls).toHaveLength(2);
	const [first, second] = calls.map(
		(c) => c.body as { clientId: string; body: string },
	);
	expect(first?.body).toBe(
		"I need help cooking Rice, step 2: “Boil the rice.”",
	);
	expect(second?.clientId).toBe(first?.clientId ?? "");
});

test("signed out, asking for help asks to sign in", async () => {
	const calls = serve({});
	const { view, button } = await start();
	fireEvent.click(button("Stop"));
	fireEvent.click(button("Ask my family for help"));
	expect((await view.findByRole("alert")).textContent).toBe(
		"Sign in to message your family.",
	);
	expect(calls).toHaveLength(0);
});

test("with nobody paired, asking for help says so and sends nothing", async () => {
	signIn();
	const calls = serve({});
	const { view, button } = await start(null);
	fireEvent.click(button("Stop"));
	fireEvent.click(button("Ask my family for help"));
	expect((await view.findByRole("alert")).textContent).toBe(
		"No person is paired yet.",
	);
	expect(calls).toHaveLength(0);
});

test("Repeat asks the voice to read the current step and reports when the voice is unavailable", async () => {
	signIn();
	const calls = serve({
		"POST /api/families/f1/voice/speech": {
			status: 503,
			json: { error: "unavailable", message: "No voice." },
		},
	});
	const { view, button } = await start();
	fireEvent.click(button("Repeat"));
	await waitFor(() =>
		expect(view.getByRole("alert").textContent).toBe(
			"The voice is not available right now.",
		),
	);
	expect(calls[0]?.body).toEqual({ text: "Wash the rice." });
});
