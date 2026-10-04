// First: registers Happy DOM before React DOM and the router load.
import "../test/dom";

import { describe, expect, test } from "bun:test";
import type { AlertAcknowledgement, Family } from "@health/contracts";
import type { FamilyAlert } from "@health/contracts/alerts";
import type { ReactNode } from "react";

import { FamilyProvider, PersonPicker } from "@/lib/family";

import {
	act,
	fireEvent,
	type Reply,
	renderHook,
	renderRouted,
	serve,
	setupDom,
	signIn,
	waitFor,
	within,
} from "../test/dom";
import { useFamilyData, useShownAlert } from "./data";
import { clock } from "./logic";
import { AlertSection, FamilyGate, ReadingsGlance } from "./parts";

setupDom();

const NOW = Date.now();
const CREATED = new Date(NOW - 5 * 60_000).toISOString();
const ACKED = new Date(NOW - 60_000).toISOString();
const ME = "a".repeat(64);

const person = (id: string, name: string): Family => ({
	id,
	name,
	createdAt: CREATED,
});

const acknowledgement = (alertId: string): AlertAcknowledgement => ({
	id: `k-${alertId}`,
	alertId,
	familyId: "f1",
	member: ME,
	acknowledgedAt: ACKED,
});

const alertItem = (id: string, seen = false): FamilyAlert => ({
	alert: {
		id,
		familyId: "f1",
		sampleId: null,
		summary: `Alert ${id}`,
		raisedBy: "server",
		createdAt: CREATED,
	},
	sample: null,
	delivery: null,
	acknowledgements: seen ? [acknowledgement(id)] : [],
});

/** Every read one person's screen makes, answered with `alerts` and one heart-rate reading. */
const personRoutes = (
	familyId: string,
	alerts: () => readonly FamilyAlert[],
) => ({
	[`GET /api/families/${familyId}/alerts`]: () => ({
		json: { alerts: alerts() },
	}),
	[`GET /api/families/${familyId}/monitoring`]: {
		json: { checkedAt: CREATED, thresholds: [] },
	},
	[`GET /api/families/${familyId}/alert-thresholds`]: {
		json: { thresholds: [] },
	},
	[`GET /api/families/${familyId}`]: {
		json: {
			families: [],
			samples: [
				{
					id: `s-${familyId}`,
					familyId,
					metric: "heart_rate",
					value: familyId === "f1" ? 72 : 64,
					unit: "bpm",
					sourceTime: CREATED,
					receivedAt: CREATED,
					source: "watch",
					synthetic: false,
					quality: "validated",
				},
			],
			alerts: [],
			messages: [],
			acknowledgements: [],
		},
	},
});

const baseRoutes = (families: Family[]) => ({
	"GET /api/families": { json: { families } },
	"GET /api/me": { json: { issuer: "test", subject: "me", identity: ME } },
});

const ACK_PATH = "POST /api/families/f1/alerts/a1/acknowledgements";

function Screen() {
	const data = useFamilyData();
	return (
		<>
			<PersonPicker />
			<FamilyGate data={data} emptyClassName="">
				{(family) => (
					<>
						<h2>{family.name}</h2>
						<AlertSection data={data} now={NOW} />
						<ReadingsGlance data={data} familyId={family.id} now={NOW} />
					</>
				)}
			</FamilyGate>
		</>
	);
}

const show = () =>
	renderRouted(
		<FamilyProvider>
			<Screen />
		</FamilyProvider>,
	);

describe("useFamilyData", () => {
	test("reads everything the screen shows for the selected person", async () => {
		signIn();
		const calls = serve({
			...baseRoutes([person("f1", "Mom")]),
			...personRoutes("f1", () => [alertItem("a1")]),
		});
		const { view } = await show();
		expect(
			await view.findByRole("article", { name: "Alert: Alert a1" }),
		).toBeDefined();
		expect(await view.findByText("72")).toBeDefined();
		expect(new Set(calls.map((c) => `${c.method} ${c.path}`))).toEqual(
			new Set([
				"GET /api/families",
				"GET /api/me",
				"GET /api/families/f1/alerts",
				"GET /api/families/f1/monitoring",
				"GET /api/families/f1/alert-thresholds",
				"GET /api/families/f1",
			]),
		);
	});

	test("Mark as seen posts, turns the button off, then shows the alert seen by you", async () => {
		signIn();
		let seen = false;
		let release: (reply: Reply) => void = () => {};
		const calls = serve({
			...baseRoutes([person("f1", "Mom")]),
			...personRoutes("f1", () => [alertItem("a1", seen)]),
			[ACK_PATH]: () =>
				new Promise<Reply>((resolve) => {
					release = resolve;
				}),
		});
		const { view } = await show();
		const article = await view.findByRole("article");
		// `me` arrives with its own read; wait for it so the seen line names "You".
		await waitFor(() =>
			expect(calls.some((c) => c.path === "/api/me")).toBe(true),
		);
		fireEvent.click(
			within(article).getByRole("button", { name: "Mark as seen" }),
		);
		await waitFor(() =>
			expect(
				(
					view.getByRole("button", {
						name: "Mark as seen",
					}) as HTMLButtonElement
				).disabled,
			).toBe(true),
		);
		expect(calls.filter((c) => c.method === "POST")).toEqual([
			{
				method: "POST",
				path: "/api/families/f1/alerts/a1/acknowledgements",
				body: undefined,
			},
		]);

		seen = true;
		await act(async () =>
			release({ json: { acknowledgement: acknowledgement("a1") } }),
		);
		const done = await view.findByRole("button", { name: "Seen" });
		expect((done as HTMLButtonElement).disabled).toBe(true);
		expect(await view.findByText(`You, ${clock(ACKED)}`)).toBeDefined();
		// The seen alert stays on screen instead of jumping to "No alerts".
		expect(view.queryByText("No alerts right now")).toBeNull();
	});

	test("a refused mark shows why and the alert stays unseen", async () => {
		signIn();
		serve({
			...baseRoutes([person("f1", "Mom")]),
			...personRoutes("f1", () => [alertItem("a1")]),
			[ACK_PATH]: {
				status: 403,
				json: { error: "forbidden", message: "Not in this family" },
			},
		});
		const { view } = await show();
		fireEvent.click(await view.findByRole("button", { name: "Mark as seen" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"Could not mark as seen: Not in this family",
		);
		const button = view.getByRole("button", { name: "Mark as seen" });
		expect((button as HTMLButtonElement).disabled).toBe(false);
	});

	test("a rejected session ends it and asks to sign in", async () => {
		signIn();
		serve({
			...baseRoutes([person("f1", "Mom")]),
			...personRoutes("f1", () => [alertItem("a1")]),
			[ACK_PATH]: { status: 401 },
		});
		const { view } = await show();
		fireEvent.click(await view.findByRole("button", { name: "Mark as seen" }));
		expect(
			await view.findByText("Sign in to see your family.", { exact: false }),
		).toBeDefined();
		expect(sessionStorage.getItem("telly.session.token")).toBeNull();
	});

	test("choosing another person clears the last person's failure", async () => {
		signIn();
		serve({
			...baseRoutes([person("f1", "Mom"), person("f2", "Dad")]),
			...personRoutes("f1", () => [alertItem("a1")]),
			...personRoutes("f2", () => [alertItem("a2")]),
			[ACK_PATH]: {
				status: 500,
				json: { error: "internal", message: "Boom" },
			},
		});
		const { view } = await show();
		fireEvent.click(await view.findByRole("button", { name: "Mark as seen" }));
		expect(await view.findByText("Could not mark as seen: Boom")).toBeDefined();

		fireEvent.change(view.getByLabelText("Person"), {
			target: { value: "f2" },
		});
		expect(
			await view.findByRole("article", { name: "Alert: Alert a2" }),
		).toBeDefined();
		expect(view.getByRole("heading", { name: "Dad" })).toBeDefined();
		expect(view.queryByText(/Could not mark as seen/)).toBeNull();
		expect(await view.findByText("64")).toBeDefined();
	});

	test("with no person selected, Mark as seen sends nothing", async () => {
		signIn();
		const calls = serve(baseRoutes([]));
		const { result } = renderHook(() => useFamilyData(), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<FamilyProvider>{children}</FamilyProvider>
			),
		});
		await waitFor(() => expect(result.current.familyState.kind).toBe("ready"));
		expect(result.current.family).toBeNull();
		expect(result.current.alerts.kind).toBe("loading");
		await act(() => result.current.markSeen("a1"));
		expect(calls.some((c) => c.method === "POST")).toBe(false);
		expect(result.current.seenError).toBeNull();
		expect(result.current.busyId).toBeNull();
	});
});

describe("useShownAlert", () => {
	test("keeps a marked alert shown until a newer unseen one arrives", () => {
		const { result, rerender } = renderHook(
			({ alerts }: { alerts: readonly FamilyAlert[] }) => useShownAlert(alerts),
			{ initialProps: { alerts: [alertItem("a1")] } },
		);
		expect(result.current?.alert.id).toBe("a1");

		rerender({ alerts: [alertItem("a1", true)] });
		expect(result.current?.alert.id).toBe("a1");
		expect(result.current?.acknowledgements).toHaveLength(1);

		rerender({ alerts: [alertItem("a2"), alertItem("a1", true)] });
		expect(result.current?.alert.id).toBe("a2");

		rerender({ alerts: [] });
		expect(result.current).toBeNull();
	});

	test("shows nothing when every alert was already seen", () => {
		const { result } = renderHook(() => useShownAlert([alertItem("a1", true)]));
		expect(result.current).toBeNull();
	});
});
