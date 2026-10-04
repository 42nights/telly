import "../test/setup";

import { describe, expect, test } from "bun:test";
import type {
	MedicineMemory,
	MedicineSighting,
} from "@health/contracts/medicine-memory";
import type { MedicineDetection } from "@health/contracts/vision";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import type { ApiResult, ApiState } from "@/lib/api";
import type { MedicineMemoryChange } from "@/lib/medicine-memory";
import {
	fireEvent,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";

import { LastSeen, RememberPlace } from "./last-seen";
import type { PictureCheck } from "./medicine-check";

installDom();

// Ages are whole minutes, so the real clock (a few ms later in each test) reads the same.
const now = Date.now();
const minutesAgo = (minutes: number) =>
	new Date(now - minutes * 60_000).toISOString();

const ME = "a".repeat(64);

const sighting = (
	id: string,
	extra: Partial<MedicineSighting> = {},
): MedicineSighting => ({
	id,
	familyId: "1",
	personId: ME,
	savedBy: "a",
	container: "Lisinopril bottle",
	place: "Kitchen counter",
	seenAt: minutesAgo(3),
	source: "camera_check",
	confidence: 0.9,
	labelRead: true,
	notFoundAt: null,
	...extra,
});

const permission = {
	places: ["Kitchen counter", "Bedside table", "Bathroom shelf"],
	setBy: "a",
	setAt: minutesAgo(600),
};

const ready = (
	value: Omit<MedicineMemory, "personId" | "people">,
): ApiState<MedicineMemory> => ({
	kind: "ready",
	value: { personId: ME, people: [ME], ...value },
	at: now,
});

/** A `change` that records what it was asked and answers when the test says so. */
const changes = () => {
	const calls: unknown[][] = [];
	let answer: (result: ApiResult<MedicineMemory>) => void = () => {};
	const change: MedicineMemoryChange = (...args) => {
		calls.push(args);
		const next = Promise.withResolvers<ApiResult<MedicineMemory>>();
		answer = next.resolve;
		return next.promise;
	};
	return {
		calls,
		change,
		answer: (result: ApiResult<MedicineMemory>) => answer(result),
	};
};

const memory: MedicineMemory = {
	personId: ME,
	people: [ME],
	permission,
	sightings: [sighting("s1")],
};

describe("LastSeen", () => {
	test("shows nothing while loading or with no paired person", () => {
		const { change } = changes();
		const view = render(
			<LastSeen
				change={change}
				familyId="1"
				item="x"
				memory={{ kind: "loading" }}
			/>,
		);
		expect(view.container.textContent).toBe("");
		view.rerender(
			<LastSeen
				change={change}
				familyId={null}
				item="x"
				memory={ready(memory)}
			/>,
		);
		expect(view.container.textContent).toBe("");
	});

	test.each([
		[{ kind: "signed_out" }, "Sign in first."],
		[{ kind: "forbidden", message: "Not your family." }, "Not your family."],
		[{ kind: "unavailable", message: "Database down." }, "Database down."],
	] as const)(
		"a failed read says the notes cannot be read (%o)",
		(state, why) => {
			const view = render(
				<LastSeen
					change={changes().change}
					familyId="1"
					item="x"
					memory={state}
				/>,
			);
			expect(view.container.textContent).toBe(
				`I can't read my notes on where medicine was last seen. ${why}`,
			);
		},
	);

	test("with remembering off it links to Settings", async () => {
		const router = createRouter({
			routeTree: createRootRoute({
				component: () => (
					<LastSeen
						change={changes().change}
						familyId="1"
						item="x"
						memory={ready({ permission: null, sightings: [] })}
					/>
				),
			}),
			history: createMemoryHistory(),
		});
		const view = render(<RouterProvider router={router} />);
		const link = await view.findByRole("link", {
			name: "Turn this on in Settings",
		});
		expect(link.getAttribute("href")).toBe("/settings/places");
		view.getByText(/I don't keep notes on where medicine was last seen\./);
	});

	test("with no sighting yet it names the item", () => {
		const view = render(
			<LastSeen
				change={changes().change}
				familyId="1"
				item="your pills"
				memory={ready({ permission, sightings: [] })}
			/>,
		);
		expect(view.container.textContent).toBe(
			"I have no note yet of where your pills was last seen. When I find it, I can remember the place.",
		);
	});

	test("shows up to three past sightings, each qualified, never as current", () => {
		const view = render(
			<LastSeen
				change={changes().change}
				familyId="1"
				item="x"
				memory={ready({
					permission,
					sightings: [
						sighting("sure"),
						sighting("old", { place: "Hall", seenAt: minutesAgo(13 * 60) }),
						sighting("unsure", { place: "Desk", labelRead: false }),
						sighting("fourth", { place: "Garage" }),
					],
				})}
			/>,
		);
		const text = view.getByRole("region", { name: "Last seen" }).textContent;
		expect(text).toContain(
			"Last seen 3 min ago at Kitchen counter: Lisinopril bottle.",
		);
		expect(text).toContain("Last seen 13 h ago at Hall");
		expect(text).toContain("Last seen 3 min ago at Desk");
		expect(text).not.toContain("Garage");
		expect(
			view.getAllByText("This note is old. It has probably moved since."),
		).toHaveLength(1);
		expect(
			view.getAllByText("I was not sure about the label then."),
		).toHaveLength(1);
		view.getByText(
			"This is where it was seen before, not where it is now. Go there and check the picture again.",
		);
		expect(
			view.getAllByRole("button", { name: "It's not there" }),
		).toHaveLength(3);
		// Nothing is out of date, so there is no family help yet.
		expect(
			view.queryByRole("button", { name: "Ask family for help" }),
		).toBeNull();
	});

	test("It's not there marks the place out of date and shows a failure", async () => {
		const { calls, change, answer } = changes();
		const view = render(
			<LastSeen
				change={change}
				familyId="1"
				item="x"
				memory={ready({ permission, sightings: [sighting("a/b")] })}
			/>,
		);
		const button = view.getByRole("button", { name: "It's not there" });
		fireEvent.click(button);
		expect(calls).toEqual([["POST", "/sightings/a%2Fb/not-found"]]);
		expect(button).toHaveProperty("disabled", true);
		answer({ kind: "error", message: "The server is not reachable." });
		expect((await view.findByRole("alert")).textContent).toBe(
			"The server is not reachable.",
		);
		expect(button).toHaveProperty("disabled", false);
		fireEvent.click(button);
		answer({ kind: "signed_out" });
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toBe("Sign in first."),
		);
		fireEvent.click(button);
		answer({ kind: "ready", value: memory });
		// A saved change shows no message: the re-read memory shows it.
		await waitFor(() => expect(view.queryByRole("alert") === null).toBe(true));
		expect(view.queryByRole("status")).toBeNull();
		expect(calls).toHaveLength(3);
	});

	test("a container that moved shows other places and asks the family once", async () => {
		let reply: (r: ServerReply) => void = () => {};
		const calls = serve({
			"POST /api/families/1/messages": () => {
				const next = Promise.withResolvers<ServerReply>();
				reply = next.resolve;
				return next.promise;
			},
		});
		const view = render(
			<LastSeen
				change={changes().change}
				familyId="1"
				item="x"
				memory={ready({
					permission,
					sightings: [
						sighting("moved", { notFoundAt: minutesAgo(2) }),
						sighting("other", { place: "Hall" }),
					],
				})}
			/>,
		);
		view.getByText("It was not there 2 min ago. This place is out of date.");
		// Only the sighting still current gets the button.
		expect(
			view.getAllByRole("button", { name: "It's not there" }),
		).toHaveLength(1);
		view.getByText("Other places to look:");
		expect(view.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
			"Bedside table",
			"Bathroom shelf",
		]);
		const ask = view.getByRole("button", { name: "Ask family for help" });
		fireEvent.click(ask);
		expect(ask).toHaveProperty("disabled", true);
		await waitFor(() => expect(calls).toHaveLength(1));
		reply({
			status: 503,
			body: { error: "unavailable", message: "Chat is down." },
		});
		expect((await view.findByRole("alert")).textContent).toBe("Chat is down.");
		expect(ask).toHaveProperty("disabled", false);
		// A retry sends the same client id, so the family gets one message.
		fireEvent.click(ask);
		await waitFor(() => expect(calls).toHaveLength(2));
		const body = {
			clientId: expect.any(String),
			body: "I can't find Lisinopril bottle. It was last seen at Kitchen counter, but it is not there now. Can you help me find it?",
		};
		expect(calls.map((c) => c.body)).toEqual([body, body]);
		expect(calls[1]?.body).toEqual(calls[0]?.body);
		reply({
			json: {
				id: "9",
				familyId: "1",
				sender: "a",
				body: body.body,
				sentAt: minutesAgo(0),
				clientId: "c",
			},
		});
		await view.findByText("I asked your family for help.");
		expect(ask).toHaveProperty("disabled", true);
	});

	test("with no other agreed place, only the family help shows", () => {
		const view = render(
			<LastSeen
				change={changes().change}
				familyId="1"
				item="x"
				memory={ready({
					permission: { ...permission, places: ["Kitchen counter"] },
					sightings: [sighting("moved", { notFoundAt: minutesAgo(2) })],
				})}
			/>,
		);
		expect(view.queryByText("Other places to look:")).toBeNull();
		view.getByRole("button", { name: "Ask family for help" });
	});
});

describe("RememberPlace", () => {
	const capturedAt = now - 30_000;
	const check: PictureCheck = {
		id: "c1",
		picture: "data:image/jpeg;base64,AA==",
		frame: { width: 640, height: 480 },
		capturedAt,
		result: { kind: "looking" },
	};
	const sure: MedicineDetection = {
		label: "Metformin",
		confidence: 0.92,
		needsVerification: false,
		box: { x: 0, y: 0, width: 10, height: 10 },
	};

	test("shows nothing until remembering is known to be on", () => {
		const { change } = changes();
		const view = render(
			<RememberPlace
				best={sure}
				change={change}
				check={check}
				memory={{ kind: "loading" }}
			/>,
		);
		expect(view.container.textContent).toBe("");
		view.rerender(
			<RememberPlace
				best={sure}
				change={change}
				check={check}
				memory={ready({ permission: null, sightings: [] })}
			/>,
		);
		expect(view.container.textContent).toBe("");
	});

	test("saves a read label at a place once one is given", async () => {
		const { calls, change, answer } = changes();
		const view = render(
			<RememberPlace
				best={sure}
				change={change}
				check={check}
				memory={ready({
					permission,
					sightings: [sighting("s", { place: "Hall" }), sighting("t")],
				})}
			/>,
		);
		const form = view.getByRole("form", { name: "Remember where it is" });
		// The agreed places and past places are offered once each.
		expect(
			[...form.querySelectorAll("option")].map((o) => o.getAttribute("value")),
		).toEqual(["Kitchen counter", "Bedside table", "Bathroom shelf", "Hall"]);
		expect(view.getByRole("textbox", { name: "What is it?" })).toHaveProperty(
			"value",
			"Metformin",
		);
		const save = view.getByRole("button", { name: "Remember this place" });
		expect(save).toHaveProperty("disabled", true);
		// A submit without a place sends nothing.
		fireEvent.submit(form);
		expect(calls).toEqual([]);
		fireEvent.change(
			view.getByRole("combobox", {
				name: "Where is it? A room or a landmark.",
			}),
			{ target: { value: "  Bedside table " } },
		);
		expect(save).toHaveProperty("disabled", false);
		fireEvent.click(save);
		expect(calls).toEqual([
			[
				"POST",
				"/sightings",
				{
					container: "Metformin",
					place: "Bedside table",
					seenAt: new Date(capturedAt).toISOString(),
					source: "camera_check",
					confidence: 0.92,
					labelRead: true,
				},
			],
		]);
		await waitFor(() => expect(save.hasAttribute("disabled")).toBe(true));
		answer({ kind: "ready", value: memory });
		expect((await view.findByRole("status")).textContent).toBe(
			"Saved as the last place it was seen. This does not record a dose.",
		);
	});

	test("an unread label must be named and checked before saving", async () => {
		const { calls, change, answer } = changes();
		const view = render(
			<RememberPlace
				best={{
					...sure,
					label: null,
					confidence: 0.5,
					needsVerification: true,
				}}
				change={change}
				check={check}
				memory={ready({ permission, sightings: [] })}
			/>,
		);
		const save = view.getByRole("button", { name: "Remember this place" });
		const name = view.getByRole("textbox", { name: "What is it?" });
		expect(name).toHaveProperty("value", "");
		fireEvent.change(name, { target: { value: "Blue pill box" } });
		fireEvent.change(
			view.getByRole("combobox", {
				name: "Where is it? A room or a landmark.",
			}),
			{ target: { value: "Hall" } },
		);
		expect(save).toHaveProperty("disabled", true);
		fireEvent.click(
			view.getByRole("checkbox", {
				name: "I read the label. It is the right medicine.",
			}),
		);
		expect(save).toHaveProperty("disabled", false);
		fireEvent.click(save);
		expect(calls[0]?.[2]).toMatchObject({
			container: "Blue pill box",
			place: "Hall",
			confidence: 0.5,
			labelRead: false,
		});
		answer({ kind: "error", message: "Remembering is off." });
		expect((await view.findByRole("alert")).textContent).toBe(
			"Remembering is off.",
		);
		expect(save).toHaveProperty("disabled", false);
	});
});
