// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { describe, expect, mock, test } from "bun:test";
import type { Family, FamilyRecords, HealthSample } from "@health/contracts";
import type {
	AlertThreshold,
	FamilyAlert,
	Monitoring,
	ThresholdMonitoring,
} from "@health/contracts/alerts";

import type { ApiState } from "@/lib/api";

import {
	fireEvent,
	render,
	renderRouted,
	setupDom,
	within,
} from "../test/dom-routed";
import type { FamilyData } from "./data";
import { clock } from "./logic";
import {
	AlertSection,
	FamilyGate,
	MonitoringBadge,
	MonitoringList,
	ReadingsGlance,
} from "./parts";

setupDom();

const NOW = Date.parse("2026-01-10T12:00:00Z");
const ME = "a".repeat(64);
const minutesAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();
const ready = <T,>(value: T): ApiState<T> => ({
	kind: "ready",
	value,
	at: NOW,
});

const family: Family = {
	id: "f1",
	name: "Mom",
	createdAt: "2026-01-01T00:00:00Z",
};

const sample = (fields: Partial<HealthSample>): HealthSample => ({
	id: "s1",
	familyId: "f1",
	metric: "heart_rate",
	value: 72,
	unit: "bpm",
	sourceTime: minutesAgo(5),
	receivedAt: minutesAgo(5),
	source: "watch",
	synthetic: false,
	quality: "validated",
	...fields,
});

const threshold = (fields: Partial<AlertThreshold> = {}): AlertThreshold => ({
	id: "t1",
	familyId: "f1",
	metric: "heart_rate",
	direction: "above",
	limit: 110,
	unit: "bpm",
	maxAgeSeconds: 600,
	updatedBy: ME,
	updatedAt: "2026-01-01T00:00:00Z",
	...fields,
});

const row = (
	state: ThresholdMonitoring["state"],
	fields: Partial<ThresholdMonitoring> = {},
): ThresholdMonitoring => ({
	threshold: threshold(),
	state,
	reason: null,
	sample: null,
	...fields,
});

const monitoring = (...thresholds: ThresholdMonitoring[]) =>
	ready<Monitoring>({ checkedAt: minutesAgo(0), thresholds });

const records = (samples: HealthSample[]) =>
	ready<FamilyRecords>({
		families: [family],
		samples,
		alerts: [],
		messages: [],
		acknowledgements: [],
	});

const alertItem = (fields: Partial<FamilyAlert> = {}): FamilyAlert => ({
	alert: {
		id: "a1",
		familyId: "f1",
		sampleId: "s1",
		summary: "Heart rate above 110 bpm",
		raisedBy: "server",
		createdAt: minutesAgo(5),
	},
	sample: sample({ value: 130 }),
	delivery: {
		alertId: "a1",
		status: "sent",
		attempts: 1,
		lastError: null,
		updatedAt: minutesAgo(4),
	},
	acknowledgements: [],
	...fields,
});

const data = (fields: Partial<FamilyData> = {}): FamilyData => ({
	familyState: ready({ families: [family] }),
	family,
	alerts: ready({ alerts: [] }),
	monitoring: monitoring(),
	thresholds: ready({ thresholds: [] }),
	records: records([]),
	me: ME,
	markSeen: async () => {},
	busyId: null,
	seenError: null,
	...fields,
});

describe("FamilyGate", () => {
	const gate = (value: FamilyData) =>
		render(
			<FamilyGate data={value} emptyClassName="empty">
				{(person) => <h2>Showing {person.name}</h2>}
			</FamilyGate>,
		);

	test("while the family list loads, it says so and shows no person", () => {
		const view = gate(data({ familyState: { kind: "loading" }, family: null }));
		expect(view.getByRole("status").textContent).toContain(
			"Loading your family…",
		);
		expect(view.queryByRole("heading")).toBeNull();
	});

	test("a failed family list shows the failure", () => {
		const view = gate(
			data({
				familyState: { kind: "forbidden", message: "No access" },
				family: null,
			}),
		);
		expect(view.getByRole("alert").textContent).toContain(
			"Not a member of this family",
		);
		expect(view.queryByRole("heading")).toBeNull();
	});

	test("with no person set up, it links to set one up", async () => {
		const { view } = await renderRouted(
			<FamilyGate data={data({ family: null })} emptyClassName="empty">
				{(person) => <h2>Showing {person.name}</h2>}
			</FamilyGate>,
		);
		const empty = view.getByText(/No person is set up with this account yet/);
		expect(empty.className).toBe("empty");
		expect(
			view.getByRole("link", { name: "Set up a person" }).getAttribute("href"),
		).toBe("/welcome");
		expect(view.queryByRole("heading")).toBeNull();
	});

	test("with a person, it renders the screen for that person", () => {
		const view = gate(data());
		expect(view.getByRole("heading").textContent).toBe("Showing Mom");
	});
});

describe("AlertSection without an alert to show", () => {
	test("a failed alerts read shows the failure, not 'no alerts'", () => {
		const view = render(
			<AlertSection
				data={data({
					alerts: { kind: "unavailable", message: "Database down" },
				})}
				now={NOW}
			/>,
		);
		const notice = view.getByRole("alert");
		expect(notice.textContent).toContain("Alerts unavailable");
		expect(notice.textContent).toContain("Database down");
		expect(view.queryByText("No alerts right now")).toBeNull();
	});

	test.each([
		[
			"unknown monitoring",
			{ kind: "loading" } as const,
			"Monitoring state is unknown, so an alert could be missed.",
		],
		[
			"every threshold live",
			monitoring(row("in_range")),
			"Every threshold has a fresh validated or WHOOP reading.",
		],
		[
			"some thresholds unavailable",
			monitoring(row("in_range"), row("unavailable")),
			"Some thresholds have no fresh validated or WHOOP reading, so an alert could be missed.",
		],
		[
			"no live threshold",
			monitoring(),
			"Monitoring is stopped: no threshold has a fresh validated or WHOOP reading.",
		],
	])(
		"with %s, it says what is watched, never 'all clear'",
		(_, state, text) => {
			const seen = alertItem({
				acknowledgements: [
					{
						id: "k1",
						alertId: "a1",
						familyId: "f1",
						member: ME,
						acknowledgedAt: minutesAgo(1),
					},
				],
			});
			const view = render(
				<AlertSection
					data={data({
						alerts: ready({ alerts: [seen] }),
						monitoring: state,
					})}
					now={NOW}
				/>,
			);
			const status = view.getByRole("status");
			expect(status.textContent).toContain("No alerts right now");
			expect(status.textContent).toContain(text);
		},
	);
});

describe("AlertSection with an alert", () => {
	const card = (value: FamilyData) =>
		renderRouted(<AlertSection data={value} now={NOW} />);

	test("an unseen alert shows its signal, delivery, and a Mark as seen button", async () => {
		const markSeen = mock(async (_alertId: string) => {});
		const { view } = await card(
			data({
				alerts: ready({
					alerts: [
						alertItem({
							delivery: {
								alertId: "a1",
								status: "failed",
								attempts: 2,
								lastError: "timeout",
								updatedAt: minutesAgo(4),
							},
						}),
					],
				}),
				markSeen,
			}),
		);
		const article = await view.findByRole("article", {
			name: "Alert: Heart rate above 110 bpm",
		});
		const inCard = within(article);
		expect(inCard.getByRole("heading").textContent).toBe(
			"Heart rate above 110 bpm",
		);
		expect(inCard.getByText("Not seen yet")).toBeDefined();
		expect(
			inCard.getByText(`${clock(minutesAgo(5))} · 5 min ago`),
		).toBeDefined();
		expect(inCard.getByText("Heart rate 130 bpm · watch")).toBeDefined();
		const delivery = inCard.getByText("Failed after 2 tries (timeout)");
		expect(delivery.className).toContain("text-destructive");
		expect(inCard.getByText("Not yet")).toBeDefined();

		fireEvent.click(inCard.getByRole("button", { name: "Mark as seen" }));
		expect(markSeen.mock.calls).toEqual([["a1"]]);
	});

	test("with no saved numbers, Call Mom is off and Settings is offered", async () => {
		const { view } = await card(
			data({ alerts: ready({ alerts: [alertItem()] }) }),
		);
		const callMom = await view.findByRole("button", { name: "Call Mom" });
		expect((callMom as HTMLButtonElement).disabled).toBe(true);
		expect(
			view.getByRole("link", { name: "Call 911" }).getAttribute("href"),
		).toBe("tel:911");
		expect(view.getByText(/Call Mom is off: no number saved/)).toBeDefined();
		expect(
			view
				.getByRole("link", { name: "Add it in Settings" })
				.getAttribute("href"),
		).toBe("/settings");
	});

	test("saved numbers become call links", async () => {
		localStorage.setItem(
			"telly.contacts",
			JSON.stringify({ momPhone: "+1 (555) 123-4567", emergency: "112" }),
		);
		const { view } = await card(
			data({ alerts: ready({ alerts: [alertItem()] }) }),
		);
		const callMom = await view.findByRole("link", { name: "Call Mom" });
		expect(callMom.getAttribute("href")).toBe("tel:+15551234567");
		expect(
			view.getByRole("link", { name: "Call 112" }).getAttribute("href"),
		).toBe("tel:112");
		expect(view.getByText(/Calls use the numbers in/)).toBeDefined();
		expect(view.getByRole("link", { name: "Settings" })).toBeDefined();
	});

	test("a manual alert with no delivery record says so", async () => {
		const { view } = await card(
			data({
				alerts: ready({
					alerts: [alertItem({ sample: null, delivery: null })],
				}),
			}),
		);
		const inCard = within(await view.findByRole("article"));
		expect(inCard.getByText("Manual alert")).toBeDefined();
		expect(inCard.getByText("No delivery record").className).not.toContain(
			"text-destructive",
		);
	});

	test("while marking, the button is off; a failure replaces the numbers line", async () => {
		const { view } = await card(
			data({
				alerts: ready({ alerts: [alertItem()] }),
				busyId: "a1",
				seenError: "Could not mark as seen: boom",
			}),
		);
		const button = await view.findByRole("button", { name: "Mark as seen" });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(view.getByRole("alert").textContent).toBe(
			"Could not mark as seen: boom",
		);
		expect(view.queryByText(/Call Mom is off/)).toBeNull();
	});
});

describe("ReadingsGlance", () => {
	test("a failed records read shows the failure", () => {
		const view = render(
			<ReadingsGlance
				data={data({ records: { kind: "error", message: "HTTP 500" } })}
				familyId="f1"
				now={NOW}
			/>,
		);
		expect(view.getByRole("alert").textContent).toContain(
			"Could not load readings",
		);
	});

	test("with no readings for this person, it says they are unavailable", () => {
		const view = render(
			<ReadingsGlance
				data={data({ records: records([sample({ familyId: "f2" })]) })}
				familyId="f1"
				now={NOW}
			/>,
		);
		expect(
			view.getByText("Unavailable: no readings stored for this person."),
		).toBeDefined();
	});

	test("shows the newest reading per metric and marks stale, unvalidated, and demo-only ones", () => {
		const view = render(
			<ReadingsGlance
				data={data({
					records: records([
						sample({ id: "hr", value: 72, sourceTime: minutesAgo(3) }),
						sample({
							id: "spo2",
							metric: "spo2",
							value: 97,
							unit: "%",
							sourceTime: minutesAgo(30),
						}),
						sample({
							id: "steps",
							metric: "steps",
							value: 900,
							unit: "steps",
							quality: "unvalidated",
						}),
						sample({ id: "hrv", metric: "hrv", synthetic: true }),
					]),
					thresholds: ready({
						thresholds: [threshold({ metric: "spo2", unit: "%" })],
					}),
				})}
				familyId="f1"
				now={NOW}
			/>,
		);
		const items = view.getAllByRole("listitem").map((li) => li.textContent);
		expect(items).toEqual([
			"Heart rate72 bpmwatch · 3 min ago",
			"HrvUnavailableNo real reading stored",
			"Spo297 %watch · 30 min agoStale",
			"Steps900 stepswatch · 5 min agoUnvalidated",
		]);
	});
});

describe("MonitoringBadge", () => {
	test.each([
		[{ kind: "loading" } as const, "Monitoring: unknown"],
		[monitoring(row("in_range")), "Monitoring: on"],
		[
			monitoring(row("out_of_range"), row("unavailable")),
			"Monitoring: partial",
		],
		[monitoring(row("unavailable")), "Monitoring: stopped"],
	])("shows the level", (state, text) => {
		const view = render(<MonitoringBadge state={state} />);
		expect(view.getByText(text)).toBeDefined();
	});
});

describe("MonitoringList", () => {
	test("a monitoring read in progress says so, and NOOP shows not connected", () => {
		const view = render(
			<MonitoringList
				state={{ kind: "loading" }}
				records={{ kind: "loading" }}
				familyId="f1"
				now={NOW}
			/>,
		);
		expect(view.getByRole("status").textContent).toContain(
			"Loading monitoring…",
		);
		expect(view.getByText("NOOP not connected")).toBeDefined();
	});

	test("no thresholds means nothing is monitored", () => {
		const view = render(
			<MonitoringList
				state={monitoring()}
				records={records([])}
				familyId="f1"
				now={NOW}
			/>,
		);
		expect(
			view.getByText("No thresholds set: nothing is monitored."),
		).toBeDefined();
		expect(view.getByText("NOOP not connected")).toBeDefined();
	});

	test("each threshold shows its state, and a NOOP sample shows WHOOP connected", () => {
		const view = render(
			<MonitoringList
				state={monitoring(
					row("in_range"),
					row("out_of_range", {
						threshold: threshold({
							id: "t2",
							direction: "below",
							limit: 40,
						}),
					}),
					row("unavailable", {
						threshold: threshold({
							id: "t3",
							metric: "spo2",
							direction: "below",
							limit: 90,
							unit: "%",
						}),
						reason: "stale",
					}),
					row("unavailable", {
						threshold: threshold({ id: "t4", metric: "steps", unit: "steps" }),
						reason: "missing",
					}),
				)}
				records={records([
					sample({
						metric: "strain",
						source: "noop:whoop",
						sourceTime: minutesAgo(5),
					}),
					sample({
						metric: "strain",
						familyId: "f2",
						source: "noop:whoop",
						sourceTime: minutesAgo(1),
					}),
				])}
				familyId="f1"
				now={NOW}
			/>,
		);
		const items = view.getAllByRole("listitem").map((li) => li.textContent);
		expect(items).toEqual([
			"Heart rate above 110 bpmIn range",
			"Heart rate below 40 bpmOut of range",
			"Spo2 below 90 %Unavailable: reading is stale",
			"Steps above 110 stepsUnavailable: no validated reading",
			"WHOOPConnected · 5 min ago · unvalidated",
		]);
		expect(view.getByText("Out of range").className).toContain(
			"text-destructive",
		);
	});
});
