import "../test/setup";

import { describe, expect, test } from "bun:test";
import type {
	SavedSpeakerSettings,
	SpeakerStatus,
} from "@health/contracts/speaker";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { FamilyProvider } from "@/lib/family";
import {
	fireEvent,
	installDom,
	type Routes,
	render,
	type ServerReply,
	serve,
	waitFor,
	within,
} from "../test/dom";

import { SpeakerSettingsWindow } from "./speaker-settings";

installDom();

const FAMILY = "/api/families/7";
const FAMILIES: ServerReply = {
	json: {
		families: [
			{ id: "7", name: "Rose", createdAt: "2026-01-01T00:00:00.000Z" },
		],
	},
};
const DEFAULTS: SavedSpeakerSettings = {
	settings: { enabled: false, room: "shared", sharedRoomKinds: [] },
	updatedBy: null,
	updatedAt: null,
};
const QUIET: SpeakerStatus = {
	provider: "simulated",
	mode: "online",
	announcements: [],
};

const failure = (status: number, message: string): ServerReply => ({
	status,
	body: { error: "internal", message },
});

const show = (routes: Routes) => {
	const calls = serve({
		"GET /api/families": FAMILIES,
		[`GET ${FAMILY}/speaker-settings`]: { json: DEFAULTS },
		[`GET ${FAMILY}/speaker`]: { json: QUIET },
		...routes,
	});
	// A 401 ends the session and the signed-out notice links to Sign in, so it needs a router.
	const router = createRouter({
		routeTree: createRootRoute({
			component: () => (
				<FamilyProvider>
					<SpeakerSettingsWindow />
				</FamilyProvider>
			),
		}),
		history: createMemoryHistory(),
	});
	const view = render(<RouterProvider router={router} />);
	return { calls, view };
};

describe("SpeakerSettingsWindow", () => {
	test("says no person is paired when the caller has no family", async () => {
		const { view, calls } = show({
			"GET /api/families": { json: { families: [] } },
		});
		expect(await view.findByText("No person is paired yet.")).toBeDefined();
		expect(calls.map((c) => c.path)).toEqual(["/api/families"]);
	});

	test("shows why the settings could not be read", async () => {
		const { view } = show({
			[`GET ${FAMILY}/speaker-settings`]: failure(403, "Not your family"),
		});
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toContain(
				"Not shared with you",
			),
		);
		expect(view.queryByRole("form")).toBeNull();
	});

	test("starts off in a shared room, with a quiet simulator", async () => {
		const { view } = show({});
		const form = await view.findByRole("form", { name: "Home speaker" });
		expect(within(form).getByRole("status").textContent).toBe(
			"Not saved yet: the speaker is off.",
		);
		expect(
			within(form).getByRole("checkbox", { name: /Say due reminders/ }),
		).toHaveProperty("checked", false);
		expect(form.textContent).toContain("It says only “You have a reminder.");
		expect(
			within(form).getByRole("group", { name: /shared room/ }),
		).toHaveProperty("disabled", false);
		expect(await view.findByText("Nothing yet.")).toBeDefined();
		expect(
			view.getByRole("combobox", { name: "Speaker state" }),
		).toHaveProperty("value", "online");
	});

	test("saves the chosen settings and shows when they were saved", async () => {
		let saved = DEFAULTS;
		const { view, calls } = show({
			[`GET ${FAMILY}/speaker-settings`]: () => ({ json: saved }),
			[`PUT ${FAMILY}/speaker-settings`]: () => {
				saved = {
					settings: {
						enabled: true,
						room: "private",
						sharedRoomKinds: ["medication"],
					},
					updatedBy: "a".repeat(64),
					updatedAt: "2026-01-01T08:00:00.000Z",
				};
				return { json: saved };
			},
		});
		const form = await view.findByRole("form", { name: "Home speaker" });
		const box = within(form);
		fireEvent.click(box.getByRole("checkbox", { name: /Say due reminders/ }));
		fireEvent.click(box.getByRole("checkbox", { name: "Medicine" }));
		fireEvent.click(box.getByRole("checkbox", { name: "Meals" }));
		expect(box.getByRole("checkbox", { name: "Meals" })).toHaveProperty(
			"checked",
			true,
		);
		fireEvent.click(box.getByRole("checkbox", { name: "Meals" }));
		fireEvent.change(box.getByRole("combobox", { name: /Where is/ }), {
			target: { value: "private" },
		});
		expect(form.textContent).toContain(
			"It says the reminder name, such as the medicine.",
		);
		expect(box.getByRole("group", { name: /shared room/ })).toHaveProperty(
			"disabled",
			true,
		);
		fireEvent.click(box.getByRole("button", { name: "Save" }));
		expect(box.getByRole("status").textContent).toBe("Saving…");
		await waitFor(() =>
			expect(
				within(view.getByRole("form", { name: "Home speaker" })).getByRole(
					"status",
				).textContent,
			).toStartWith("Saved · "),
		);
		expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
			{ enabled: true, room: "private", sharedRoomKinds: ["medication"] },
		]);
		expect(
			view.getByRole("checkbox", { name: /Say due reminders/ }),
		).toHaveProperty("checked", true);
	});

	test("says why a save failed", async () => {
		let reply = failure(500, "Disk full");
		const { view } = show({
			[`PUT ${FAMILY}/speaker-settings`]: () => reply,
		});
		const form = await view.findByRole("form", { name: "Home speaker" });
		fireEvent.submit(form);
		await waitFor(() =>
			expect(within(form).getByRole("status").textContent).toBe(
				"Not saved: Disk full",
			),
		);
		reply = { status: 401 };
		fireEvent.submit(form);
		// The session ends, so the family list re-reads signed out and no person is chosen.
		expect(await view.findByText("No person is paired yet.")).toBeDefined();
		expect(view.queryByRole("form") === null).toBe(true);
	});

	test("lists what the simulator said and changes its state", async () => {
		let status: SpeakerStatus = {
			...QUIET,
			announcements: [
				{
					occurrenceId: "3",
					text: "You have a reminder. Please check your phone.",
					at: "2026-01-01T08:00:00.000Z",
				},
			],
		};
		let reply: ServerReply | null = null;
		const { view, calls } = show({
			[`GET ${FAMILY}/speaker`]: () => ({ json: status }),
			[`PUT ${FAMILY}/speaker/simulator`]: () => {
				if (reply !== null) return reply;
				status = { ...status, mode: "offline" };
				return { json: status };
			},
		});
		const said = await view.findByRole("listitem");
		expect(said.textContent).toContain(
			"“You have a reminder. Please check your phone.”",
		);
		const state = () => view.getByRole("combobox", { name: "Speaker state" });
		fireEvent.change(state(), { target: { value: "offline" } });
		await waitFor(() => expect(state()).toHaveProperty("value", "offline"));
		expect(
			calls.filter((c) => c.path === `${FAMILY}/speaker`).length,
		).toBeGreaterThanOrEqual(2);
		expect(view.queryByRole("alert")).toBeNull();

		reply = failure(500, "Simulator stuck");
		fireEvent.change(state(), { target: { value: "refused" } });
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toBe(
				"Not changed: Simulator stuck",
			),
		);
		await waitFor(() => expect(state()).toHaveProperty("value", "offline"));

		reply = { status: 401 };
		fireEvent.change(state(), { target: { value: "refused" } });
		// Compare to null: a failed `toBeNull()` on a DOM node formats the whole tree and stalls.
		await waitFor(() => expect(view.queryByRole("alert") === null).toBe(true));
		expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
			{ mode: "offline" },
			{ mode: "refused" },
			{ mode: "refused" },
		]);
	});

	test("shows why the simulator could not be read", async () => {
		const { view } = show({
			[`GET ${FAMILY}/speaker`]: failure(500, "Simulator gone"),
		});
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toContain(
				"Could not load the simulated speakerSimulator gone",
			),
		);
	});
});
