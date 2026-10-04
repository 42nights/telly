import "../test/setup";

import { describe, expect, test } from "bun:test";
import type {
	MedicineMemory,
	MedicineSighting,
} from "@health/contracts/medicine-memory";
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
	serve,
	waitFor,
	within,
} from "../test/dom";

import { SavedThingsSettings } from "./saved-things";

installDom();

const PATH = "/api/families/7/medicine-memory";
const ME = "a".repeat(64);
const MOM = "b".repeat(64);

const thing = (
	id: string,
	container: string,
	category: MedicineSighting["category"],
): MedicineSighting => ({
	id,
	familyId: "7",
	personId: ME,
	savedBy: ME,
	container,
	place: "Hall table",
	seenAt: new Date(Date.now() - 60 * 60_000).toISOString(),
	source: "camera_check",
	confidence: 0.9,
	labelRead: true,
	notFoundAt: null,
	category,
	thumbnail: category === "keys" ? "/9j/AA" : "",
	usualPlace: null,
	pinned: false,
});

const SAVED: MedicineMemory = {
	personId: ME,
	people: [ME],
	places: [],
	sightings: [thing("1", "keys", "keys"), thing("2", "Aspirin", "medicine")],
};

const show = async (routes: Routes) => {
	const calls = serve({
		"GET /api/families": {
			json: {
				families: [
					{ id: "7", name: "Rose", createdAt: "2026-01-01T00:00:00.000Z" },
				],
			},
		},
		...routes,
	});
	const router = createRouter({
		routeTree: createRootRoute({
			component: () => (
				<FamilyProvider>
					<SavedThingsSettings />
				</FamilyProvider>
			),
		}),
		history: createMemoryHistory(),
	});
	const view = render(<RouterProvider router={router} />);
	const frame = await view.findByRole("region", {
		name: "Settings · Saved things",
	});
	return { calls, view, frame };
};

const changes = (calls: { method: string; path: string; body: unknown }[]) =>
	calls
		.filter((c) => c.method !== "GET")
		.map((c) => [c.method, c.path, c.body]);

describe("SavedThingsSettings", () => {
	test("shows why the saved things could not be read", async () => {
		const { view } = await show({
			[`GET ${PATH}`]: {
				status: 503,
				body: { error: "internal", message: "Database not configured" },
			},
		});
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toContain(
				"Database not configured",
			),
		);
	});

	test("lists each saved thing with its picture, place, and age, and links to Add a thing", async () => {
		const { view, frame } = await show({ [`GET ${PATH}`]: { json: SAVED } });
		const list = await view.findByRole("list", { name: "Saved things" });
		expect(
			within(list)
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual([
			"keysHall table · 1 h agoRemove",
			"AspirinHall table · 1 h agoRemove",
		]);
		expect(list.querySelectorAll("img")).toHaveLength(1);
		expect(frame.textContent).toContain("2 saved");
		expect(
			view.getByRole("link", { name: "Add a thing" }).getAttribute("href"),
		).toBe(`/find?mode=add&member=${ME}`);
		// No opt-in: remembering is on for every member (#301).
		expect(view.queryByRole("checkbox")).toBeNull();
	});

	test("Remove asks first, then forgets only that thing", async () => {
		let memory = SAVED;
		const { view, calls } = await show({
			[`GET ${PATH}`]: () => ({ json: memory }),
			[`DELETE ${PATH}/sightings/1`]: () => {
				memory = { ...SAVED, sightings: [thing("2", "Aspirin", "medicine")] };
				return { json: memory };
			},
		});
		fireEvent.click(await view.findByRole("button", { name: "Remove keys" }));
		const ask = view.getByRole("alertdialog", { name: "Remove keys?" });
		fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
		expect(view.queryByRole("alertdialog")).toBeNull();
		expect(changes(calls)).toEqual([]);

		fireEvent.click(view.getByRole("button", { name: "Remove keys" }));
		fireEvent.click(
			within(view.getByRole("alertdialog")).getByRole("button", {
				name: "Remove",
			}),
		);
		await view.findByText("1 saved");
		expect(changes(calls)).toEqual([
			["DELETE", `${PATH}/sightings/1`, undefined],
		]);
		expect(
			within(view.getByRole("list", { name: "Saved things" }))
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["AspirinHall table · 1 h agoRemove"]);
	});

	test("Forget everything asks first, then deletes every thing of the member", async () => {
		let memory = SAVED;
		const { view, calls } = await show({
			[`GET ${PATH}`]: () => ({ json: memory }),
			[`PUT ${PATH}`]: () => {
				memory = { ...SAVED, sightings: [] };
				return { json: memory };
			},
		});
		fireEvent.click(
			await view.findByRole("button", { name: "Forget everything" }),
		);
		const ask = view.getByRole("alertdialog", { name: "Forget everything?" });
		expect(ask.textContent).toContain("AR room maps are deleted");
		fireEvent.click(
			within(ask).getByRole("button", { name: "Forget everything" }),
		);
		await view.findByText("No saved things yet.");
		expect(changes(calls)).toEqual([
			["PUT", PATH, { enabled: false, places: [] }],
		]);
		expect(
			view.queryByRole("button", { name: "Forget everything" }),
		).toBeNull();
	});

	test("a refused change says why and keeps the thing", async () => {
		const { view } = await show({
			[`GET ${PATH}`]: { json: SAVED },
			[`DELETE ${PATH}/sightings/1`]: {
				status: 403,
				body: { error: "forbidden", message: "No care access" },
			},
		});
		fireEvent.click(await view.findByRole("button", { name: "Remove keys" }));
		fireEvent.click(
			within(view.getByRole("alertdialog")).getByRole("button", {
				name: "Remove",
			}),
		);
		expect((await view.findByRole("alert")).textContent).toBe(
			"Not changed: No care access",
		);
		view.getByRole("button", { name: "Remove keys" });
	});

	test("shows only the chosen member's things, changes that member's, and remembers the choice", async () => {
		localStorage.clear();
		const mine = { ...SAVED, people: [ME, MOM] };
		const hers: MedicineMemory = {
			...mine,
			personId: MOM,
			sightings: [{ ...thing("3", "glasses", "glasses"), personId: MOM }],
		};
		const { view, calls } = await show({
			[`GET ${PATH}`]: { json: mine },
			[`GET ${PATH}?person=${MOM}`]: { json: hers },
			[`DELETE ${PATH}/sightings/3?person=${MOM}`]: { json: hers },
		});
		const picker = await view.findByLabelText("Whose things?");
		expect(picker).toHaveProperty("value", ME);
		fireEvent.change(picker, { target: { value: MOM } });
		fireEvent.click(
			await view.findByRole("button", { name: "Remove glasses" }),
		);
		expect(localStorage.getItem("telly.medicine-person.7")).toBe(MOM);
		expect(
			view.getByRole("link", { name: "Add a thing" }).getAttribute("href"),
		).toBe(`/find?mode=add&member=${MOM}`);
		fireEvent.click(
			within(view.getByRole("alertdialog")).getByRole("button", {
				name: "Remove",
			}),
		);
		await waitFor(() =>
			expect(changes(calls)).toEqual([
				["DELETE", `${PATH}/sightings/3?person=${MOM}`, undefined],
			]),
		);
	});

	test("the wearer view shows only the wearer's own, with no picker", async () => {
		localStorage.setItem("telly.medicine-person.7", MOM);
		localStorage.setItem("telly.view", "wearer");
		const { view, calls } = await show({
			[`GET ${PATH}`]: { json: { ...SAVED, people: [ME, MOM] } },
		});
		await view.findByRole("list", { name: "Saved things" });
		expect(view.queryByLabelText("Whose things?")).toBeNull();
		expect(
			calls.filter((c) => c.path.startsWith(PATH)).map((c) => c.path),
		).toEqual([PATH]);
	});
});
