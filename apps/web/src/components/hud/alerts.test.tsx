// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type { Alert, FamilyRecords } from "@health/contracts";

import { render, setupDom, within } from "../test/dom-routed";
import { Alerts } from "./alerts";

setupDom();

const now = Date.parse("2026-10-04T12:00:00Z");

const alert = (id: string, familyId: string, minutesAgo: number): Alert => ({
	id,
	familyId,
	sampleId: null,
	summary: `Alert ${id}`,
	raisedBy: "wearer",
	createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
});

const empty: FamilyRecords = {
	families: [],
	samples: [],
	messages: [],
	alerts: [],
	acknowledgements: [],
};

test("while loading or after a failure, the alerts region says so", () => {
	const loading = render(
		<Alerts familyId="f1" now={now} records={{ kind: "loading" }} />,
	);
	expect(loading.getByRole("status").textContent).toContain("Loading alerts…");
	loading.unmount();

	const failed = render(
		<Alerts
			familyId="f1"
			now={now}
			records={{ kind: "error", message: "Server down" }}
		/>,
	);
	const notice = failed.getByRole("alert");
	expect(notice.textContent).toContain("Could not load alerts");
	expect(notice.textContent).toContain("Server down");
});

test("no alerts for this family is never shown as an all-clear", () => {
	const view = render(
		<Alerts
			familyId="f1"
			now={now}
			records={{
				kind: "ready",
				at: now,
				value: { ...empty, alerts: [alert("a1", "f2", 1)] },
			}}
		/>,
	);
	expect(view.getByRole("status").textContent).toBe("No alerts recorded.");
	expect(view.queryByText("Alert a1")).toBeNull();
});

test("this family's alerts show newest first with age and whether family saw them", () => {
	const view = render(
		<Alerts
			familyId="f1"
			now={now}
			records={{
				kind: "ready",
				at: now,
				value: {
					...empty,
					alerts: [
						alert("old", "f1", 120),
						alert("new", "f1", 3),
						alert("x", "f2", 0),
					],
					acknowledgements: [
						{
							id: "ack1",
							alertId: "old",
							familyId: "f1",
							member: "daughter",
							acknowledgedAt: new Date(now).toISOString(),
						},
					],
				},
			}}
		/>,
	);
	const items = view.getAllByRole("listitem");
	expect(
		items.map((item) => within(item).getByText(/^Alert /).textContent),
	).toEqual(["Alert new", "Alert old"]);
	expect(items[0]?.textContent).toContain("3 min ago · Not seen yet");
	expect(items[1]?.textContent).toContain("2 h ago · Seen by family");
	expect(items[0]?.querySelector("time")?.getAttribute("dateTime")).toBe(
		"2026-10-04T11:57:00.000Z",
	);
});
