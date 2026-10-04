import "../test/setup";

import { afterEach, describe, expect, test } from "bun:test";
import type { Trip } from "@health/contracts/trips";
import {
	fireEvent,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";

import { TripCheckInCard } from "./trip";

installDom();

const me = "a".repeat(64);
const trip = (extra: Partial<Trip> = {}): Trip => ({
	id: "5",
	status: "leaving",
	source: "manual",
	plan: {
		purpose: "groceries",
		destination: "the corner shop",
		statedAt: "2026-10-04T08:00:00.000Z",
		statedBy: me,
	},
	notify: { departure: true, arrival: false },
	events: [],
	...extra,
});
const CURRENT = "GET /api/families/1/trips/current";
const ANSWER = "POST /api/families/1/trips/5/answer";

type Battery = { getBattery?: () => Promise<{ level: number }> };
const setBattery = (getBattery: Battery["getBattery"]) =>
	Object.assign(navigator, { getBattery });
afterEach(() => {
	Reflect.deleteProperty(navigator, "getBattery");
});

describe("TripCheckInCard", () => {
	test("shows nothing and reads nothing without a family", () => {
		const calls = serve({});
		const view = render(<TripCheckInCard familyId={null} />);
		expect(view.container.textContent).toBe("");
		expect(calls).toEqual([]);
	});

	test("waits for the server, then shows a failed read as a failure", async () => {
		const pending = Promise.withResolvers<ServerReply>();
		serve({ [CURRENT]: () => pending.promise });
		const view = render(<TripCheckInCard familyId="1" />);
		expect(view.getByText("Waiting for the server.")).toBeDefined();
		pending.resolve({
			status: 500,
			body: { error: "unavailable", message: "Database down" },
		});
		expect(await view.findByText("Database down")).toBeDefined();
		expect(view.queryByRole("button")).toBeNull();
	});

	test("I'm going out starts a manual check-in and then shows the question", async () => {
		let current: Trip | null = null;
		const calls = serve({
			[CURRENT]: () => ({ json: { trip: current } }),
			"POST /api/families/1/trips/check-in": () => {
				current = trip({ status: "asked", plan: null });
				return {
					json: {
						asked: true,
						question: "Are you heading out now?",
						trip: current,
					},
				};
			},
		});
		const view = render(<TripCheckInCard familyId="1" />);
		fireEvent.click(await view.findByRole("button", { name: "I'm going out" }));
		expect(await view.findByText("Are you heading out now?")).toBeDefined();
		expect(calls.find((c) => c.method === "POST")?.body).toEqual({
			source: "manual",
		});
	});

	test("a cancelled or arrived trip offers a new check-in", async () => {
		for (const status of ["cancelled", "arrived"] as const) {
			serve({ [CURRENT]: { json: { trip: trip({ status }) } } });
			const view = render(<TripCheckInCard familyId="1" />);
			expect(
				await view.findByRole("button", { name: "I'm going out" }),
			).toBeDefined();
			view.unmount();
		}
	});

	test("Not now at the question cancels the trip", async () => {
		let current = trip({ status: "asked", plan: null });
		const calls = serve({
			[CURRENT]: () => ({ json: { trip: current } }),
			[ANSWER]: () => {
				current = trip({ status: "cancelled" });
				return { json: { trip: current, essentials: [], prompt: null } };
			},
		});
		const view = render(<TripCheckInCard familyId="1" />);
		fireEvent.click(await view.findByRole("button", { name: "Not now" }));
		expect(
			await view.findByRole("button", { name: "I'm going out" }),
		).toBeDefined();
		expect(calls.find((c) => c.path.endsWith("/answer"))?.body).toEqual({
			answer: "cancel",
		});
	});

	test("Yes opens an empty plan; saving sends the trimmed plan, the choices, and the battery", async () => {
		setBattery(() => Promise.resolve({ level: 0.42 }));
		let current = trip({ status: "asked", plan: null });
		const calls = serve({
			[CURRENT]: () => ({ json: { trip: current } }),
			[ANSWER]: () => {
				current = trip();
				return {
					json: {
						trip: current,
						essentials: ["keys"],
						prompt: "Do you have your keys?",
					},
				};
			},
			"POST /api/families/1/voice/speech": { json: {} },
		});
		const view = render(<TripCheckInCard familyId="1" />);
		fireEvent.click(await view.findByRole("button", { name: "Yes" }));
		const purpose = view.getByRole("textbox", {
			name: "What are you going out for?",
		});
		expect((purpose as HTMLInputElement).value).toBe("");
		expect(view.getByRole("button", { name: "Not now" })).toBeDefined();
		fireEvent.change(purpose, { target: { value: "  groceries  " } });
		fireEvent.change(
			view.getByRole("textbox", { name: "Where to? (optional)" }),
			{
				target: { value: "   " },
			},
		);
		fireEvent.click(
			view.getByRole("checkbox", { name: "Tell my family I left" }),
		);
		fireEvent.click(
			view.getByRole("checkbox", { name: "Tell my family I arrived" }),
		);
		fireEvent.click(view.getByRole("button", { name: "Save my plan" }));
		expect(await view.findByText("Do you have your keys?")).toBeDefined();
		expect(calls.find((c) => c.path.endsWith("/answer"))?.body).toEqual({
			answer: "leaving",
			purpose: "groceries",
			destination: null,
			notify: { departure: false, arrival: true },
			battery: 0.42,
		});
		// The preparation prompt is read aloud on arrival.
		await waitFor(() =>
			expect(calls.find((c) => c.path.endsWith("/voice/speech"))?.body).toEqual(
				{ text: "Do you have your keys?" },
			),
		);
		expect(
			view.getByText("You're going out for groceries to the corner shop."),
		).toBeDefined();
	});

	test("the battery is null when the browser does not report it or fails", async () => {
		for (const getBattery of [
			undefined,
			() => Promise.reject(new Error("no battery")),
		]) {
			setBattery(getBattery);
			let current = trip({ status: "asked" });
			const calls = serve({
				[CURRENT]: () => ({ json: { trip: current } }),
				[ANSWER]: () => {
					// Another device ended the trip meanwhile; the re-read shows it.
					current = trip({ status: "arrived" });
					return { status: 500 };
				},
			});
			const view = render(<TripCheckInCard familyId="1" />);
			fireEvent.click(await view.findByRole("button", { name: "Yes" }));
			// The saved plan fills the form.
			expect(
				(
					view.getByRole("textbox", {
						name: "Where to? (optional)",
					}) as HTMLInputElement
				).value,
			).toBe("the corner shop");
			fireEvent.click(view.getByRole("button", { name: "Save my plan" }));
			expect(
				await view.findByRole("button", { name: "I'm going out" }),
			).toBeDefined();
			expect(view.getByRole("alert").textContent).toBe("HTTP 500");
			expect(calls.find((c) => c.path.endsWith("/answer"))?.body).toEqual({
				answer: "leaving",
				purpose: "groceries",
				destination: "the corner shop",
				notify: { departure: true, arrival: false },
				battery: null,
			});
			view.unmount();
		}
	});

	test("an active trip reads its plan aloud and records arrival", async () => {
		let current = trip({
			plan: {
				purpose: "a walk",
				destination: null,
				statedAt: "2026-10-04T08:00:00.000Z",
				statedBy: me,
			},
		});
		const calls = serve({
			[CURRENT]: () => ({ json: { trip: current } }),
			[ANSWER]: () => {
				current = trip({ status: "arrived" });
				return { json: { trip: current, essentials: [], prompt: null } };
			},
			"POST /api/families/1/voice/speech": { status: 503 },
		});
		const view = render(<TripCheckInCard familyId="1" />);
		expect(await view.findByText("You're going out for a walk.")).toBeDefined();
		expect(view.queryByRole("status")).toBeNull();
		fireEvent.click(view.getByRole("button", { name: "Remind me" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"The voice is not available right now.",
		);
		expect(calls.find((c) => c.path.endsWith("/voice/speech"))?.body).toEqual({
			text: "You're going out for a walk.",
		});
		fireEvent.click(view.getByRole("button", { name: "I arrived" }));
		expect(
			await view.findByRole("button", { name: "I'm going out" }),
		).toBeDefined();
		expect(calls.find((c) => c.path.endsWith("/answer"))?.body).toEqual({
			answer: "arrived",
		});
	});

	test("a trip without a plan; a failed cancel keeps it, the form's cancel ends it", async () => {
		let current = trip({ plan: null });
		const calls = serve({
			[CURRENT]: () => ({ json: { trip: current } }),
			[ANSWER]: (call) => {
				if (calls.filter((c) => c.path === call.path).length === 1)
					return {
						status: 503,
						body: { error: "unavailable", message: "Try later" },
					};
				current = trip({ status: "cancelled" });
				return { json: { trip: current, essentials: [], prompt: null } };
			},
		});
		const view = render(<TripCheckInCard familyId="1" />);
		expect(
			await view.findByText("You're going out for your trip."),
		).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Cancel trip" }));
		expect((await view.findByRole("alert")).textContent).toBe("Try later");
		// The trip stays active after the failed cancel.
		fireEvent.click(view.getByRole("button", { name: "My plans changed" }));
		fireEvent.click(view.getByRole("button", { name: "Cancel trip" }));
		expect(
			await view.findByRole("button", { name: "I'm going out" }),
		).toBeDefined();
		expect(view.queryByRole("alert")).toBeNull();
		expect(
			calls.filter((c) => c.path.endsWith("/answer")).map((c) => c.body),
		).toEqual([{ answer: "cancel" }, { answer: "cancel" }]);
	});

	test("a signed-out save asks to sign in", async () => {
		// The re-read after the send stays pending, so the alert is the last change.
		const later = Promise.withResolvers<ServerReply>();
		const calls = serve({
			[CURRENT]: () =>
				calls.length === 1 ? { json: { trip: null } } : later.promise,
			"POST /api/families/1/trips/check-in": { status: 401 },
		});
		const view = render(<TripCheckInCard familyId="1" />);
		fireEvent.click(await view.findByRole("button", { name: "I'm going out" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"Sign in to save your trip.",
		);
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			CURRENT,
			"POST /api/families/1/trips/check-in",
			CURRENT,
		]);
	});
});
