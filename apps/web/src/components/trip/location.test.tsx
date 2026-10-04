import "../test/setup";

import { describe, expect, mock, test } from "bun:test";
import type {
	FamilyLocations,
	LocationShare,
	SharedLocation,
} from "@health/contracts/location";
import { clock } from "@/components/family/logic";
import {
	act,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
	within,
} from "../test/dom";

import { FamilyLocationSection, LocationCard, WhoSeesMe } from "./location";

installDom();

const now = Date.parse("2026-01-01T08:00:00Z");
const at = (minutesAgo: number) =>
	new Date(now - minutesAgo * 60_000).toISOString();
const me = "a".repeat(64);
const sister = "b".repeat(64);
const brother = "c".repeat(64);

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
	events: [],
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

const sharesPath = (viewer: string) =>
	`/api/families/1/location/shares/${viewer}`;
const ok: ServerReply = { json: locations([]) };
const MEMBERS = "GET /api/families/1/members";
const members: ServerReply = {
	json: {
		members: [
			{ identity: me, name: "Ana" },
			{ identity: sister, name: "Rosa Rivera" },
			{ identity: brother, name: null },
		],
	},
};
// Rosa holds Location access; nobody else does.
const access: ServerReply = {
	json: {
		mine: [],
		grants: [
			{
				identity: sister,
				scope: "location",
				granted: true,
				changedBy: me,
				changedAt: at(10),
			},
		],
		history: [],
	},
};

describe("WhoSeesMe", () => {
	test("lists every other member by name with an on/off box, never by identity", async () => {
		const calls = serve({
			[MEMBERS]: members,
			"GET /api/families/1/care-access": access,
			[`DELETE ${sharesPath(sister)}`]: ok,
		});
		const onChange = mock(() => {});
		const view = render(
			<WhoSeesMe
				familyId="1"
				locations={locations([share(sister), share(brother)])}
				me={me}
				onChange={onChange}
			/>,
		);
		await waitFor(() =>
			expect(view.container.textContent).toContain("Cannot see it yet"),
		);
		const boxes = view.getAllByRole("checkbox");
		expect(
			boxes.map((b) => [
				b.closest("label")?.textContent,
				b instanceof HTMLInputElement && b.checked,
			]),
		).toEqual([
			["Rosa Rivera", true],
			[
				"Family memberCannot see it yet: turn on Location for them in Care › Sharing.",
				true,
			],
		]);
		expect(view.container.textContent).not.toContain(sister.slice(0, 6));
		await act(async () => boxes[0]?.click());
		expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
			`DELETE ${sharesPath(sister)}`,
		);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	test("a refused change shows why and changes nothing", async () => {
		serve({
			[MEMBERS]: members,
			"GET /api/families/1/care-access": access,
			[`PUT ${sharesPath(sister)}`]: {
				status: 403,
				body: { error: "forbidden", message: "Not a member." },
			},
		});
		const onChange = mock(() => {});
		const view = render(
			<WhoSeesMe
				familyId="1"
				locations={locations([])}
				me={me}
				onChange={onChange}
			/>,
		);
		const [rosa] = await view.findAllByRole("checkbox");
		await act(async () => rosa?.click());
		expect(view.getByRole("alert").textContent).toBe(
			"Not changed: Not a member.",
		);
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("FamilyLocationSection", () => {
	const path = "GET /api/families/1/location";

	test("shows the locations shared with me by name, not my own", async () => {
		serve({
			[MEMBERS]: members,
			[path]: {
				json: {
					locations: [location({ sharer: me }), location({})],
					shares: [],
					seesShared: true,
					events: [],
				},
			},
		});
		const view = render(
			<FamilyLocationSection familyId="1" me={me} now={now} />,
		);
		const section = view.getByRole("region", { name: "Location" });
		await waitFor(() =>
			expect(
				within(section).getByRole("heading", { level: 4 }).textContent,
			).toBe("Rosa Rivera"),
		);
		expect(within(section).getAllByRole("article")).toHaveLength(1);
		expect(section.textContent).not.toContain(me);
	});

	test("lists trip notices of people who share with me, not my own, with a map link", async () => {
		const event = (id: string, over: Record<string, unknown>) => ({
			id,
			familyId: "1",
			sharer: sister,
			kind: "left",
			manual: false,
			fix: null,
			at: at(5),
			...over,
		});
		serve({
			[MEMBERS]: members,
			[path]: {
				json: {
					locations: [location({})],
					shares: [],
					seesShared: true,
					events: [
						event("3", { kind: "back", fix: location({}).fix }),
						event("2", { manual: true }),
						event("1", { sharer: me }),
					],
				},
			},
		});
		const view = render(
			<FamilyLocationSection familyId="1" me={me} now={now} />,
		);
		const list = await view.findByRole("list", { name: "Going out" });
		await waitFor(() => expect(list.textContent).toContain("Rosa Rivera"));
		const items = within(list).getAllByRole("listitem");
		expect(items.map((i) => i.textContent?.split(" at ")[0])).toEqual([
			"Rosa Rivera is back home",
			"Rosa Rivera left home",
		]);
		// A manual start has no fix of its own; the link opens the person's latest position.
		for (const item of items)
			expect(
				within(item)
					.getByRole("link", { name: "Open on a map" })
					.getAttribute("href"),
			).toContain("mlat=51.500123456");
	});

	test("says when nobody shares a location", async () => {
		serve({
			[path]: {
				json: {
					locations: [location({})],
					shares: [],
					seesShared: true,
					events: [],
				},
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
	});

	test("says when location sharing is off for me", async () => {
		serve({
			[path]: {
				json: {
					locations: [location({})],
					shares: [],
					seesShared: false,
					events: [],
				},
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
		const alert = view.getByRole("alert");
		expect(alert.textContent).toContain("Location unavailable");
		expect(alert.textContent).toContain("Location is off.");
		expect(view.queryByRole("article")).toBeNull();
	});
});
