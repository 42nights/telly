import "../test/setup";

import { describe, expect, test } from "bun:test";
import type { MedicineMemory } from "@health/contracts/medicine-memory";
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

import { MedicineMemorySettings } from "./medicine-memory";

installDom();

const PATH = "/api/families/7/medicine-memory";
const ME = "a".repeat(64);
const MOM = "b".repeat(64);
const OFF: MedicineMemory = {
	personId: ME,
	people: [ME],
	permission: null,
	sightings: [],
};
const ON: MedicineMemory = {
	...OFF,
	permission: {
		places: ["Kitchen counter", "Bedside table"],
		setBy: ME,
		setAt: "2026-01-01T08:00:00.000Z",
	},
};

const show = (routes: Routes) => {
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
	const view = render(
		<FamilyProvider>
			<MedicineMemorySettings />
		</FamilyProvider>,
	);
	const frame = view.getByRole("region", {
		name: "Settings · Medicine places",
	});
	return { calls, view, frame };
};

const puts = (calls: { method: string; body: unknown }[]) =>
	calls.filter((c) => c.method === "PUT").map((c) => c.body);

describe("MedicineMemorySettings", () => {
	test("shows why the places could not be read", async () => {
		const { view } = show({
			[`GET ${PATH}`]: {
				status: 503,
				body: { error: "internal", message: "Database not configured" },
			},
		});
		expect(view.getByRole("status").textContent).toContain(
			"Loading medicine places…",
		);
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toContain(
				"Medicine places unavailableDatabase not configured",
			),
		);
	});

	test("turns remembering on with the trimmed places, then shows it is on", async () => {
		let memory = OFF;
		const { view, calls, frame } = show({
			[`GET ${PATH}`]: () => ({ json: memory }),
			[`PUT ${PATH}`]: () => {
				memory = ON;
				return { json: memory };
			},
		});
		const form = await view.findByRole("form", { name: "Medicine places" });
		expect(frame.textContent).toContain("Off: no places are saved");
		expect(within(form).queryByRole("textbox") === null).toBe(true);
		expect(form.textContent).not.toContain("deletes every saved place");
		fireEvent.click(within(form).getByRole("checkbox"));
		fireEvent.change(within(form).getByRole("textbox"), {
			target: { value: " Kitchen counter \n\n Bedside table" },
		});
		fireEvent.click(within(form).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(frame.textContent).toContain("On · saved "));
		expect(puts(calls)).toEqual([
			{ enabled: true, places: ["Kitchen counter", "Bedside table"] },
		]);
		expect(view.getByRole("textbox")).toHaveProperty(
			"value",
			"Kitchen counter\nBedside table",
		);
	});

	test("warns that turning it off deletes the places, and sends no places", async () => {
		const { view, calls } = show({
			[`GET ${PATH}`]: { json: ON },
			[`PUT ${PATH}`]: { json: OFF },
		});
		const form = await view.findByRole("form", { name: "Medicine places" });
		fireEvent.click(within(form).getByRole("checkbox"));
		expect(form.textContent).toContain(
			"Turning this off deletes every saved place of this member.",
		);
		fireEvent.submit(form);
		await waitFor(() =>
			expect(puts(calls)).toEqual([{ enabled: false, places: [] }]),
		);
	});

	test("blocks a save with more than 12 places or a place over 120 characters", async () => {
		const { view } = show({ [`GET ${PATH}`]: { json: ON } });
		const box = await view.findByRole("textbox");
		const save = view.getByRole("button", { name: "Save" });
		fireEvent.change(box, {
			target: {
				value: Array.from({ length: 13 }, (_, i) => `Place ${i}`).join("\n"),
			},
		});
		expect(save).toHaveProperty("disabled", true);
		fireEvent.change(box, { target: { value: "x".repeat(121) } });
		expect(save).toHaveProperty("disabled", true);
		fireEvent.change(box, { target: { value: "x".repeat(120) } });
		expect(save).toHaveProperty("disabled", false);
	});

	test("says why a save failed", async () => {
		let reply: ServerReply = {
			status: 500,
			body: { error: "internal", message: "Disk full" },
		};
		const { view, calls, frame } = show({
			[`GET ${PATH}`]: { json: ON },
			[`PUT ${PATH}`]: () => reply,
		});
		const form = await view.findByRole("form", { name: "Medicine places" });
		fireEvent.submit(form);
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toBe("Not saved: Disk full"),
		);
		// A 401 ends the session: the family list re-reads as signed out, so no
		// family is chosen and the form gives way to the waiting notice.
		reply = { status: 401 };
		fireEvent.submit(form);
		await waitFor(() =>
			expect(within(frame).queryByRole("form") === null).toBe(true),
		);
		expect(within(frame).getByRole("status").textContent).toContain(
			"Loading medicine places…",
		);
		expect(puts(calls)).toHaveLength(2);
	});

	test("shows only the chosen member's places, saves to that member, and remembers the choice", async () => {
		localStorage.clear();
		const mine = { ...ON, people: [ME, MOM] };
		const hers: MedicineMemory = {
			...mine,
			personId: MOM,
			permission: {
				places: ["Bathroom shelf"],
				setBy: ME,
				setAt: "2026-01-01T08:00:00.000Z",
			},
		};
		const { view, calls } = show({
			[`GET ${PATH}`]: { json: mine },
			[`GET ${PATH}?person=${MOM}`]: { json: hers },
			[`PUT ${PATH}?person=${MOM}`]: { json: hers },
		});
		const picker = await view.findByLabelText("Whose medicines?");
		expect(picker).toHaveProperty("value", ME);
		expect(
			within(picker)
				.getAllByRole("option")
				.map((o) => o.textContent),
		).toEqual(["You", `Member ${"b".repeat(6)}`]);
		expect(view.getByRole("textbox")).toHaveProperty(
			"value",
			"Kitchen counter\nBedside table",
		);

		fireEvent.change(picker, { target: { value: MOM } });
		await waitFor(() =>
			expect(view.getByRole("textbox")).toHaveProperty(
				"value",
				"Bathroom shelf",
			),
		);
		expect(localStorage.getItem("telly.medicine-person.7")).toBe(MOM);
		fireEvent.click(view.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(
				calls.some(
					(c) => c.path === `${PATH}?person=${MOM}` && c.method === "PUT",
				),
			).toBe(true),
		);
	});

	test("a remembered member the caller may no longer open falls back to their own", async () => {
		localStorage.setItem("telly.medicine-person.7", MOM);
		const { view } = show({
			[`GET ${PATH}`]: { json: ON },
			[`GET ${PATH}?person=${MOM}`]: {
				status: 403,
				body: { error: "forbidden", message: "Only your own" },
			},
		});
		const picker = await view.findByLabelText("Whose medicines?");
		await waitFor(() => expect(picker).toHaveProperty("value", ME));
		expect(localStorage.getItem("telly.medicine-person.7")).toBeNull();
	});

	test("the wearer view shows only the wearer's own, with no picker", async () => {
		localStorage.setItem("telly.medicine-person.7", MOM);
		localStorage.setItem("telly.view", "wearer");
		const { view, calls } = show({
			[`GET ${PATH}`]: { json: { ...ON, people: [ME, MOM] } },
		});
		await view.findByRole("form", { name: "Medicine places" });
		expect(view.queryByLabelText("Whose medicines?")).toBeNull();
		expect(
			calls.filter((c) => c.path.startsWith(PATH)).map((c) => c.path),
		).toEqual([PATH]);
	});
});
