import "../test/setup";

import { describe, expect, test } from "bun:test";
import type {
	MedicineMemory,
	MedicineSighting,
} from "@health/contracts/medicine-memory";
import type { ObjectDetection } from "@health/contracts/vision";
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
	within,
} from "../test/dom";

import { RememberPlace, SavedThings } from "./last-seen";
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
	category: "medicine",
	thumbnail: "",
	usualPlace: null,
	pinned: false,
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

/** Renders `node` inside a router, for the links to Settings. */
const routed = async (node: React.ReactNode) => {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => node }),
		history: createMemoryHistory(),
	});
	const view = render(<RouterProvider router={router} />);
	await waitFor(() => expect(view.container.textContent).not.toBe(""));
	return view;
};

const keys = sighting("k", {
	container: "keys",
	category: "keys",
	place: "Hall table",
	seenAt: minutesAgo(60),
	thumbnail: "/9j/AA",
	usualPlace: "Hall table",
});

describe("SavedThings", () => {
	const props = {
		change: changes().change,
		familyId: "1",
		asked: null,
		ar: false,
	} as const;

	test("shows nothing while loading or with no paired person", () => {
		const view = render(
			<SavedThings {...props} memory={{ kind: "loading" }} />,
		);
		expect(view.container.textContent).toBe("");
		view.rerender(
			<SavedThings {...props} familyId={null} memory={ready(memory)} />,
		);
		expect(view.container.textContent).toBe("");
	});

	test.each([
		[{ kind: "signed_out" }, "Sign in first."],
		[{ kind: "forbidden", message: "Not your family." }, "Not your family."],
	] as const)(
		"a failed read says the notes cannot be read (%o)",
		(state, why) => {
			const view = render(<SavedThings {...props} memory={state} />);
			expect(view.container.textContent).toBe(
				`I can't read my notes on where things were last seen. ${why}`,
			);
		},
	);

	test("with remembering off it links to Settings", async () => {
		const view = await routed(
			<SavedThings
				{...props}
				memory={ready({ permission: null, sightings: [] })}
			/>,
		);
		const link = view.getByRole("link", { name: "Turn this on in Settings" });
		expect(link.getAttribute("href")).toBe("/settings/places");
		view.getByText(/I don't keep notes on where things were last seen\./);
	});

	test("with nothing saved it says how to save", () => {
		const view = render(
			<SavedThings {...props} memory={ready({ permission, sightings: [] })} />,
		);
		expect(view.container.textContent).toBe(
			"No saved things yet. Point the camera at something you often lose, then tap Save.",
		);
	});

	test("lists every saved thing; picking one shows its last and usual place, never as current", () => {
		const view = render(
			<SavedThings
				{...props}
				memory={ready({
					permission,
					sightings: [
						sighting("sure"),
						keys,
						sighting("old", {
							container: "Glasses",
							category: "glasses",
							place: "Desk",
							seenAt: minutesAgo(13 * 60),
						}),
					],
				})}
			/>,
		);
		const list = view.getByRole("region", { name: "Where is my…?" });
		expect(view.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
			"Lisinopril bottleKitchen counter · 3 min ago",
			"keysHall table · 1 h ago",
			"GlassesDesk · 13 h ago",
		]);
		// Only a thing saved with a picture shows one.
		expect(list.querySelectorAll("img")).toHaveLength(1);
		expect(view.queryByText(/Last seen/)).toBeNull();

		fireEvent.click(view.getByRole("button", { name: /^keys/ }));
		expect(
			view.getByRole("button", { name: /^keys/ }).getAttribute("aria-pressed"),
		).toBe("true");
		expect(list.textContent).toContain("Last seen 1 h ago at Hall table.");
		expect(list.textContent).toContain("Usually kept at Hall table.");
		view.getByText(
			"This is where it was seen before, not where it is now. Go there and check with the camera.",
		);
		// No AR on this device.
		expect(view.queryByRole("button", { name: "Show me in AR" })).toBeNull();

		fireEvent.click(view.getByRole("button", { name: /^Glasses/ }));
		view.getByText("This note is old. It has probably moved since.");
		expect(view.queryByText(/Usually kept/)).toBeNull();
	});

	test("a request for a kind of thing opens the first saved one of that kind", () => {
		const view = render(
			<SavedThings
				{...props}
				asked="keys"
				memory={ready({ permission, sightings: [sighting("s"), keys] })}
			/>,
		);
		expect(view.container.textContent).toContain(
			"Last seen 1 h ago at Hall table.",
		);
		expect(view.container.textContent).not.toContain("at Kitchen counter.");
	});

	test("It's not there marks the place out of date and shows a failure", async () => {
		const { calls, change, answer } = changes();
		const view = render(
			<SavedThings
				{...props}
				asked="medicine"
				change={change}
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
		answer({ kind: "ready", value: memory });
		// A saved change shows no message: the re-read memory shows it.
		await waitFor(() => expect(view.queryByRole("alert") === null).toBe(true));
		expect(calls).toHaveLength(2);
	});

	test("a thing that moved shows other places and asks the family once", async () => {
		let reply: (r: ServerReply) => void = () => {};
		const calls = serve({
			"POST /api/families/1/messages": () => {
				const next = Promise.withResolvers<ServerReply>();
				reply = next.resolve;
				return next.promise;
			},
		});
		const view = render(
			<SavedThings
				{...props}
				asked="medicine"
				memory={ready({
					permission,
					sightings: [sighting("moved", { notFoundAt: minutesAgo(2) })],
				})}
			/>,
		);
		view.getByText("It was not there 2 min ago. This place is out of date.");
		expect(view.queryByRole("button", { name: "It's not there" })).toBeNull();
		view.getByText("Other places to look:");
		expect(
			[...view.container.querySelectorAll("ul.list-disc li")].map(
				(li) => li.textContent,
			),
		).toEqual(["Bedside table", "Bathroom shelf"]);
		const ask = view.getByRole("button", { name: "Ask family for help" });
		fireEvent.click(ask);
		await waitFor(() => expect(calls).toHaveLength(1));
		reply({
			status: 503,
			body: { error: "unavailable", message: "Chat is down." },
		});
		expect((await view.findByRole("alert")).textContent).toBe("Chat is down.");
		// A retry sends the same client id, so the family gets one message.
		fireEvent.click(ask);
		await waitFor(() => expect(calls).toHaveLength(2));
		expect(calls[1]?.body).toEqual(calls[0]?.body);
		expect(calls[0]?.body).toEqual({
			clientId: expect.any(String),
			body: "I can't find Lisinopril bottle. It was last seen at Kitchen counter, but it is not there now. Can you help me find it?",
		});
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
	const sure: ObjectDetection = {
		category: "medicine",
		label: "Metformin",
		confidence: 0.92,
		needsVerification: false,
		box: { x: 0, y: 0, width: 10, height: 10 },
	};
	const place = (value: string) =>
		fireEvent.change(
			within(document.body).getByRole("combobox", {
				name: "Where is it? A room or a spot.",
			}),
			{ target: { value } },
		);

	test("shows nothing while loading, and links to Settings while remembering is off", async () => {
		const { change } = changes();
		const loading = render(
			<RememberPlace
				ar={null}
				best={sure}
				change={change}
				check={check}
				memory={{ kind: "loading" }}
			/>,
		);
		expect(loading.container.textContent).toBe("");
		loading.unmount();
		const off = await routed(
			<RememberPlace
				ar={null}
				best={sure}
				change={change}
				check={check}
				memory={ready({ permission: null, sightings: [] })}
			/>,
		);
		expect(
			off.getByRole("link", { name: "Settings" }).getAttribute("href"),
		).toBe("/settings/places");
	});

	test("saves any thing with its kind and picture at a place once one is given", async () => {
		const { calls, change, answer } = changes();
		const view = render(
			<RememberPlace
				ar={null}
				best={{ ...sure, category: "keys", label: null, confidence: 0.6 }}
				change={change}
				check={check}
				memory={ready({
					permission,
					sightings: [sighting("s", { place: "Hall" }), sighting("t")],
				})}
			/>,
		);
		const form = view.getByRole("form", { name: "Save where it is" });
		// The agreed places and past places are offered once each.
		expect(
			[...form.querySelectorAll("option")].map((o) => o.getAttribute("value")),
		).toEqual(["Kitchen counter", "Bedside table", "Bathroom shelf", "Hall"]);
		// A thing without a label is named by its kind, and the person may rename it.
		expect(view.getByRole("textbox", { name: "What is it?" })).toHaveProperty(
			"value",
			"keys",
		);
		// Only medicine needs a label check, even when the model was unsure.
		expect(view.queryByRole("checkbox")).toBeNull();
		const save = view.getByRole("button", { name: "Save this place" });
		expect(save).toHaveProperty("disabled", true);
		fireEvent.submit(form);
		expect(calls).toEqual([]);
		place("  Bedside table ");
		expect(save).toHaveProperty("disabled", false);
		fireEvent.click(save);
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]).toEqual([
			"POST",
			"/sightings",
			{
				container: "keys",
				place: "Bedside table",
				seenAt: new Date(capturedAt).toISOString(),
				source: "camera_check",
				confidence: 0.6,
				labelRead: false,
				category: "keys",
				thumbnail: expect.any(String),
			},
		]);
		expect(save).toHaveProperty("disabled", true);
		answer({ kind: "ready", value: memory });
		expect((await view.findByRole("status")).textContent).toBe(
			"Saved as the last place it was seen.",
		);
	});

	test("an unread medicine label must be named and checked before saving", async () => {
		const { calls, change, answer } = changes();
		const view = render(
			<RememberPlace
				ar={null}
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
		const save = view.getByRole("button", { name: "Save this place" });
		const name = view.getByRole("textbox", { name: "What is it?" });
		expect(name).toHaveProperty("value", "");
		fireEvent.change(name, { target: { value: "Blue pill box" } });
		place("Hall");
		expect(save).toHaveProperty("disabled", true);
		fireEvent.click(
			view.getByRole("checkbox", {
				name: "I read the label. It is the right medicine.",
			}),
		);
		expect(save).toHaveProperty("disabled", false);
		fireEvent.click(save);
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]?.[2]).toMatchObject({
			container: "Blue pill box",
			place: "Hall",
			confidence: 0.5,
			labelRead: false,
			category: "medicine",
		});
		answer({ kind: "error", message: "Remembering is off." });
		expect((await view.findByRole("alert")).textContent).toBe(
			"Remembering is off.",
		);
		expect(save).toHaveProperty("disabled", false);
	});

	test("a saved medicine says no dose was recorded", async () => {
		const { calls, change, answer } = changes();
		const view = render(
			<RememberPlace
				ar={null}
				best={sure}
				change={change}
				check={check}
				memory={ready({ permission, sightings: [] })}
			/>,
		);
		place("Hall");
		fireEvent.click(view.getByRole("button", { name: "Save this place" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		answer({ kind: "ready", value: memory });
		expect((await view.findByRole("status")).textContent).toBe(
			"Saved as the last place it was seen. This does not record a dose.",
		);
	});

	test("on an iPhone with AR, Save then pins the saved thing in AR by its object id", async () => {
		const pinPath = "PUT /api/families/1/medicine-memory/objects/k/ar-pin";
		const calls = serve({ [pinPath]: { json: { anchorId: "telly-pin-k" } } });
		const sent: Record<string, unknown>[] = [];
		globalThis.ReactNativeWebView = {
			postMessage: (data) => {
				const request = JSON.parse(data) as Record<string, unknown>;
				sent.push(request);
				queueMicrotask(() =>
					globalThis.dispatchEvent(
						new CustomEvent("telly-ar", {
							detail: {
								type: "ar.pinSaved",
								requestId: request.requestId,
								anchorId: "telly-pin-k",
								worldMap: "bWFw",
								mapBytes: 3,
							},
						}),
					),
				);
			},
		};
		try {
			const saves = changes();
			const { change, answer } = saves;
			const view = render(
				<RememberPlace
					ar="1"
					best={{ ...sure, category: "keys", label: "Keys" }}
					change={change}
					check={check}
					memory={ready({ permission, sightings: [] })}
				/>,
			);
			place("Hall table");
			fireEvent.click(view.getByRole("button", { name: "Save this place" }));
			await waitFor(() => expect(saves.calls).toHaveLength(1));
			answer({
				kind: "ready",
				value: {
					...memory,
					sightings: [sighting("k", { container: "keys", category: "keys" })],
				},
			});
			await waitFor(() =>
				expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([pinPath]),
			);
			expect(sent[0]).toMatchObject({
				type: "ar.savePin",
				familyId: "1",
				objectId: "k",
				label: "keys",
			});
			expect(calls[0]?.body).toEqual({
				anchorId: "telly-pin-k",
				worldMap: "bWFw",
			});
		} finally {
			globalThis.ReactNativeWebView = undefined;
		}
	});
});
