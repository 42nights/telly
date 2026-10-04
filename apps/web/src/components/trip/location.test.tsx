import "../test/setup";

import { describe, expect, test } from "bun:test";
import type { FamilyRecords } from "@health/contracts";
import type {
	FamilyLocations,
	LocationShare,
	SharedLocation,
} from "@health/contracts/location";
import { clock } from "@/components/family/logic";
import type { ApiState } from "@/lib/api";
import {
	act,
	fireEvent,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
	within,
} from "../test/dom";

import {
	FamilyLocationSection,
	LocationCard,
	SharingControls,
} from "./location";

installDom();

const now = Date.parse("2026-01-01T08:00:00Z");
const at = (minutesAgo: number) =>
	new Date(now - minutesAgo * 60_000).toISOString();
const me = "a".repeat(64);
const sister = "b".repeat(64);
const brother = "c".repeat(64);
const cousin = "d".repeat(64);

const location = (over: Partial<SharedLocation>): SharedLocation => ({
	familyId: "1",
	sharer: sister,
	status: "fix",
	fix: {
		latitude: 51.500123456,
		longitude: -0.1234567,
		accuracyMeters: 12.4,
		fixTime: at(1),
	},
	reportedAt: at(0),
	...over,
});
const share = (viewer: string): LocationShare => ({
	familyId: "1",
	sharer: me,
	viewer,
	sharedAt: at(60),
});
const locations = (shares: LocationShare[]): FamilyLocations => ({
	locations: [],
	shares,
	seesShared: true,
});

describe("LocationCard", () => {
	test("a current fix shows its label, position, accuracy, fix time, map link, and report time", () => {
		const view = render(
			<LocationCard location={location({})} name="Member bbbbbb" now={now} />,
		);
		expect(view.getByRole("heading").textContent).toBe("Member bbbbbb");
		expect(view.queryByRole("status")).toBeNull();
		const text = view.container.textContent;
		expect(text).toContain("Current position, within 12 m.");
		expect(text).toContain(
			`51.50012, -0.12346 · within 12 m · taken ${clock(at(1))}`,
		);
		expect(text).toContain(`Last report from the phone: ${clock(at(0))}`);
		const map = view.getByRole("link", { name: "Open on a map" });
		expect(map.getAttribute("href")).toBe(
			"https://www.openstreetmap.org/?mlat=51.500123456&mlon=-0.1234567#map=17/51.500123456/-0.1234567",
		);
		expect(map.getAttribute("target")).toBe("_blank");
	});

	test("a location that is not current is announced as a status", () => {
		const view = render(
			<LocationCard
				location={location({ status: "no_fix" })}
				name="Sister"
				now={now}
			/>,
		);
		const status = view.getByRole("status");
		expect(status.dataset.kind).toBe("no_signal");
		expect(status.textContent).toContain("Showing the last known position.");
		expect(view.getByRole("link", { name: "Open on a map" })).toBeDefined();
	});

	test("without any fix it shows no position and no map link", () => {
		const view = render(
			<LocationCard
				location={location({ status: "no_fix", fix: null })}
				name="Sister"
				now={now}
			/>,
		);
		expect(view.getByRole("status").textContent).toBe(
			"The phone has not found a position yet.",
		);
		expect(view.queryByRole("link")).toBeNull();
		expect(view.container.textContent).toContain("Last report from the phone");
	});
});

const records = (
	senders: string[],
	members: string[],
): ApiState<FamilyRecords> => ({
	kind: "ready",
	at: now,
	value: {
		families: [],
		samples: [],
		alerts: [],
		messages: senders.map((sender, index) => ({
			id: `m${index}`,
			familyId: "1",
			sender,
			body: "hi",
			sentAt: at(5),
			clientId: `c${index}`,
		})),
		acknowledgements: members.map((member, index) => ({
			id: `a${index}`,
			alertId: "1",
			familyId: "1",
			member,
			acknowledgedAt: at(5),
		})),
	},
});
const sharesPath = (viewer: string) =>
	`/api/families/1/location/shares/${viewer}`;
const ok: ServerReply = { json: locations([]) };

describe("SharingControls", () => {
	test("with no shares it says nothing is sent, and offers no members while records load", () => {
		serve({});
		const view = render(
			<SharingControls
				familyId="1"
				locations={locations([])}
				me={me}
				records={{ kind: "loading" }}
			/>,
		);
		expect(view.container.textContent).toContain(
			"Nobody. Telly sends no location until you share it with someone.",
		);
		expect(
			view.getAllByRole("button").map((button) => button.textContent),
		).toEqual(["Share"]);
	});

	test("lists each of my shares and stops one on request", async () => {
		const calls = serve({ [`DELETE ${sharesPath(sister)}`]: ok });
		const view = render(
			<SharingControls
				familyId="1"
				locations={{
					locations: [],
					shares: [share(sister), { ...share(me), sharer: brother }],
					seesShared: true,
				}}
				me={me}
				records={{ kind: "loading" }}
			/>,
		);
		const items = view.getAllByRole("listitem");
		expect(items).toHaveLength(1);
		expect(items[0]?.textContent).toContain(
			`Member bbbbbb · since ${clock(at(60))}`,
		);
		await act(async () =>
			view
				.getByRole("button", { name: "Stop sharing with Member bbbbbb" })
				.click(),
		);
		expect(calls).toEqual([
			{ method: "DELETE", path: sharesPath(sister), body: undefined },
		]);
	});

	test("offers members seen in the records, except me and those already shared with", async () => {
		const calls = serve({ [`PUT ${sharesPath(cousin)}`]: ok });
		const view = render(
			<SharingControls
				familyId="1"
				locations={locations([share(sister)])}
				me={me}
				records={records([me, sister, cousin, cousin], [brother, cousin])}
			/>,
		);
		expect(
			view
				.getAllByRole("button")
				.map((button) => button.textContent)
				.filter((text) => text?.startsWith("Share with")),
		).toEqual(["Share with Member dddddd", "Share with Member cccccc"]);
		await act(async () =>
			view.getByRole("button", { name: "Share with Member dddddd" }).click(),
		);
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			`PUT ${sharesPath(cousin)}`,
		]);
	});

	test("shares by a typed sharing ID only when it is a valid identity, then clears the field", async () => {
		const calls = serve({ [`PUT ${sharesPath(cousin)}`]: ok });
		const view = render(
			<SharingControls
				familyId="1"
				locations={locations([])}
				me={me}
				records={{ kind: "loading" }}
			/>,
		);
		const field = view.getByLabelText(
			"Share with a family member by their sharing ID",
		);
		const submit = view.getByRole("button", { name: "Share" });
		expect(field.getAttribute("aria-invalid")).toBe("false");
		expect(submit.hasAttribute("disabled")).toBe(true);

		fireEvent.change(field, { target: { value: "not-an-id" } });
		expect(field.getAttribute("aria-invalid")).toBe("true");
		expect(submit.hasAttribute("disabled")).toBe(true);
		fireEvent.submit(field.closest("form") ?? field);
		expect(calls).toEqual([]);

		fireEvent.change(field, { target: { value: `  ${cousin} ` } });
		expect(field.getAttribute("aria-invalid")).toBe("false");
		expect(submit.hasAttribute("disabled")).toBe(false);
		await act(async () => submit.click());
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			`PUT ${sharesPath(cousin)}`,
		]);
		expect(field).toHaveProperty("value", "");
	});

	test("buttons are off while a change is in flight", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		serve({ [`DELETE ${sharesPath(sister)}`]: () => reply.promise });
		const view = render(
			<SharingControls
				familyId="1"
				locations={locations([share(sister)])}
				me={me}
				records={records([cousin], [])}
			/>,
		);
		const stop = view.getByRole("button", {
			name: "Stop sharing with Member bbbbbb",
		});
		await act(async () => stop.click());
		expect(stop.hasAttribute("disabled")).toBe(true);
		expect(
			view
				.getByRole("button", { name: "Share with Member dddddd" })
				.hasAttribute("disabled"),
		).toBe(true);
		await act(async () => reply.resolve(ok));
		expect(stop.hasAttribute("disabled")).toBe(false);
	});

	test.each([
		[{ status: 401 }, "Sign in again to change sharing."],
		[
			{ status: 403, body: { error: "forbidden", message: "Not a member." } },
			"Not a member.",
		],
		[
			{
				status: 503,
				body: { error: "unavailable", message: "Database down." },
			},
			"Database down.",
		],
	])("a refused change shows why and changes nothing", async (reply, text) => {
		serve({ [`DELETE ${sharesPath(sister)}`]: reply });
		const view = render(
			<SharingControls
				familyId="1"
				locations={locations([share(sister)])}
				me={me}
				records={{ kind: "loading" }}
			/>,
		);
		await act(async () =>
			view
				.getByRole("button", { name: "Stop sharing with Member bbbbbb" })
				.click(),
		);
		expect(view.getByRole("alert").textContent).toBe(text);
	});
});

describe("FamilyLocationSection", () => {
	const path = "GET /api/families/1/location";

	test("shows the locations shared with me, not my own, and copies my sharing ID without showing it", async () => {
		serve({
			[path]: {
				json: {
					locations: [location({ sharer: me }), location({})],
					shares: [],
					seesShared: true,
				},
			},
		});
		const copied: string[] = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					copied.push(text);
				},
			},
		});
		const view = render(
			<FamilyLocationSection familyId="1" me={me} now={now} />,
		);
		const section = view.getByRole("region", { name: "Location" });
		await waitFor(() =>
			expect(within(section).getAllByRole("article")).toHaveLength(1),
		);
		expect(within(section).getByRole("heading", { level: 4 }).textContent).toBe(
			"Member bbbbbb",
		);
		expect(section.textContent).not.toContain(me);
		fireEvent.click(
			within(section).getByRole("button", { name: "Copy my sharing ID" }),
		);
		await waitFor(() => expect(copied).toEqual([me]));
		await waitFor(() => expect(section.textContent).toContain("Copied."));
	});

	test("says when nobody shares a location, and shows no ID before I am known", async () => {
		serve({
			[path]: {
				json: { locations: [location({})], shares: [], seesShared: true },
			},
		});
		const view = render(
			<FamilyLocationSection familyId="1" me={sister} now={now} />,
		);
		await waitFor(() =>
			expect(view.container.textContent).toContain(
				"Nobody shares a location with you.",
			),
		);
		view.rerender(<FamilyLocationSection familyId="1" me={null} now={now} />);
		expect(view.queryByRole("button", { name: "Copy my sharing ID" })).toBe(
			null,
		);
		expect(view.getAllByRole("article")).toHaveLength(1);
	});

	test("says when location sharing is off for me", async () => {
		serve({
			[path]: {
				json: { locations: [location({})], shares: [], seesShared: false },
			},
		});
		const view = render(
			<FamilyLocationSection familyId="1" me={sister} now={now} />,
		);
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toStartWith(
				"Location sharing is off for you.",
			),
		);
		expect(view.queryByRole("article")).toBeNull();
	});

	test("shows loading, then a failed read as a failure, never as a location", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		serve({ [path]: () => reply.promise });
		const view = render(
			<FamilyLocationSection familyId="1" me={me} now={now} />,
		);
		expect(view.getByRole("status").textContent).toContain("Loading location…");
		await act(async () =>
			reply.resolve({
				status: 503,
				body: { error: "unavailable", message: "Location is off." },
			}),
		);
		const alert = await view.findByRole("alert");
		expect(alert.textContent).toContain("Location unavailable");
		expect(alert.textContent).toContain("Location is off.");
		expect(view.queryByRole("article")).toBeNull();
	});
});
