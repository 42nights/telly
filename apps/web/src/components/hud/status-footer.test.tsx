// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { afterEach, expect, jest, test } from "bun:test";
import type { FamilyRecords, HealthSample } from "@health/contracts";
import type { RenderResult } from "@testing-library/react";

import { setSessionToken } from "@/lib/session";

import { act, render, serve, setupDom } from "../test/dom-routed";
import { StatusFooter } from "./status-footer";

setupDom();
// Bun shares React DOM across test files: a static import would load it before Happy DOM.
const { renderToString } = await import("react-dom/server");

const HEALTH = { status: "ok", service: "server" } as const;
const NOT_CONNECTED = {
	sources: [{ source: "noop", status: "not_connected", lastSeenAt: null }],
};
/** The server never answers, so only the device chips change. */
const SILENT = { "GET /health": "hang", "GET /api/sources": "hang" } as const;

afterEach(() => {
	Reflect.deleteProperty(navigator, "getBattery");
	Reflect.deleteProperty(navigator, "onLine");
	jest.useRealTimers();
});

const serverLine = (view: RenderResult) =>
	view.getByText(/^(Checking the server|Server )/);

test("before the server answers, every chip says what is still unknown", async () => {
	const calls = serve(SILENT);
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	expect(serverLine(view).textContent).toBe("Checking the server…");
	expect(view.getByText("Monitoring: checking…")).toBeDefined();
	expect(
		view.getByText("WHOOP · status unknown · last contact unknown"),
	).toBeDefined();
	expect(
		view.getByText("Glasses not paired · optional · nothing needs them"),
	).toBeDefined();
	// Happy DOM has no Battery Status API: the battery is unknown, never 0 %.
	expect(view.getByText("This phone · online · battery unknown")).toBeDefined();
	expect(view.queryByRole("status")).toBeNull();
	expect(calls.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
		"GET /api/sources",
		"GET /health",
	]);
});

test("a fresh reply is connected, and it turns stale after three missed polls", async () => {
	serve({
		"GET /health": { json: HEALTH },
		"GET /api/sources": { json: NOT_CONNECTED },
	});
	const now = Date.now();
	const sample: HealthSample = {
		id: "s1",
		familyId: "f1",
		metric: "heart_rate",
		value: 61,
		unit: "bpm",
		sourceTime: new Date(now - 3_600_000).toISOString(),
		receivedAt: new Date(now).toISOString(),
		source: "noop:strap",
		synthetic: false,
		quality: "unvalidated",
	};
	const records: { kind: "ready"; value: FamilyRecords; at: number } = {
		kind: "ready",
		at: now,
		value: {
			families: [],
			samples: [sample],
			alerts: [],
			messages: [],
			acknowledgements: [],
		},
	};
	const view = render(<StatusFooter now={now} records={records} />);
	expect(await view.findByText("Monitoring: stopped")).toBeDefined();
	expect(serverLine(view).textContent).toBe(
		"Server connected · last reply 0 s ago",
	);
	expect(
		view.getByText(
			"WHOOP · not connected · no new readings · wear unknown · last reading 1 h ago · saved, not current",
		),
	).toBeDefined();

	view.rerender(<StatusFooter now={now + 20_000} records={records} />);
	expect(serverLine(view).textContent).toMatch(
		/^Server data stale · last reply (19|20) s ago$/,
	);
});

test("a failed read says the server is unavailable and why", async () => {
	serve({
		"GET /health": { status: 500, json: { error: "boom", message: "boom" } },
		"GET /api/sources": "network-error",
	});
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	expect(
		await view.findByText("Monitoring: unknown · the server did not answer"),
	).toBeDefined();
	const line = serverLine(view);
	expect(line.textContent).toBe("Server unavailable · no reply yet");
	expect(line.getAttribute("title")).toBe(
		"GET http://server.test/health failed with HTTP 500",
	);
});

test("no configured source is reported as stopped, not as watched", async () => {
	serve({
		"GET /health": { json: HEALTH },
		"GET /api/sources": { json: { sources: [] } },
	});
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	expect(
		await view.findByText("Monitoring: stopped · no health source configured"),
	).toBeDefined();
	expect(
		view.getByText("WHOOP · no source configured · last contact unknown"),
	).toBeDefined();
});

test("polling re-reads every 5 s, keeps the last good reply time, and stops on unmount", async () => {
	jest.useFakeTimers();
	let healthy = true;
	const calls = serve({
		"GET /health": () =>
			healthy ? { json: HEALTH } : { status: 503, json: null },
		"GET /api/sources": { json: NOT_CONNECTED },
	});
	const start = Date.now();
	const view = render(<StatusFooter now={start} records={null} />);
	await act(async () => {});
	expect(serverLine(view).textContent).toBe(
		"Server connected · last reply 0 s ago",
	);

	healthy = false;
	await act(async () => {
		jest.advanceTimersByTime(5_000);
	});
	view.rerender(<StatusFooter now={start + 6_000} records={null} />);
	expect(serverLine(view).textContent).toBe(
		"Server unavailable · last reply 6 s ago",
	);
	expect(calls.filter(({ path }) => path === "/health")).toHaveLength(2);

	view.unmount();
	jest.advanceTimersByTime(15_000);
	expect(calls.filter(({ path }) => path === "/health")).toHaveLength(2);
});

test("a read still pending at the next poll is cancelled, and polling goes on", async () => {
	jest.useFakeTimers();
	serve(SILENT);
	const signals: AbortSignal[] = [];
	const fetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.signal) signals.push(init.signal);
			return fetch(input, init);
		},
		{ preconnect: () => {} },
	);
	render(<StatusFooter now={Date.now()} records={null} />);
	expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
	await act(async () => {
		jest.advanceTimersByTime(5_000);
	});
	expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
	await act(async () => {
		jest.advanceTimersByTime(5_000);
	});
	expect(signals.map((signal) => signal.aborted)).toEqual([
		true,
		true,
		false,
		false,
	]);
});

test("the phone chip shows the battery level and follows its changes", async () => {
	serve(SILENT);
	const manager = Object.assign(new EventTarget(), {
		level: 0.42,
		charging: false,
	});
	Object.defineProperty(navigator, "getBattery", {
		configurable: true,
		value: async () => manager,
	});
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	expect(
		view.getByText("This phone · online · battery: checking…"),
	).toBeDefined();
	expect(
		await view.findByText("This phone · online · battery 42 %"),
	).toBeDefined();
	act(() => {
		manager.level = 0.5;
		manager.charging = true;
		manager.dispatchEvent(new Event("chargingchange"));
	});
	expect(
		view.getByText("This phone · online · battery 50 % · charging"),
	).toBeDefined();
});

test("a battery read that fails reports the battery unknown", async () => {
	serve(SILENT);
	Object.defineProperty(navigator, "getBattery", {
		configurable: true,
		value: () => Promise.reject(new Error("blocked")),
	});
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	expect(
		await view.findByText("This phone · online · battery unknown"),
	).toBeDefined();
});

test("going offline says what waits, and coming back online clears it", () => {
	serve(SILENT);
	let online = true;
	Object.defineProperty(navigator, "onLine", {
		configurable: true,
		get: () => online,
	});
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	act(() => {
		online = false;
		window.dispatchEvent(new Event("offline"));
	});
	expect(
		view.getByText(
			"This phone · offline · answers, directions, and messages wait · battery unknown",
		),
	).toBeDefined();
	act(() => {
		online = true;
		window.dispatchEvent(new Event("online"));
	});
	expect(view.getByText("This phone · online · battery unknown")).toBeDefined();
});

test("a server-rendered footer assumes online and still checks battery and server", () => {
	const html = renderToString(<StatusFooter now={0} records={null} />);
	expect(html).toContain("This phone · online · battery: checking…");
	expect(html).toContain("Checking the server…");
	expect(html).not.toContain("saved on this phone");
});

const token = `h.${Buffer.from(JSON.stringify({ iss: "https://id.test", sub: "wearer", exp: 4e9 })).toString("base64url")}.s`;

test.each([
	[1, "1 action saved on this phone · sent once when the connection returns"],
	[2, "2 actions saved on this phone · sent once when the connection returns"],
])("%i saved action(s) of the signed-in wearer are counted", (count, text) => {
	serve(SILENT);
	setSessionToken(token);
	localStorage.setItem(
		"telly.pending",
		JSON.stringify(
			[
				...Array(count).fill("https://id.test wearer"),
				"https://id.test someone-else",
			].map((owner: string, i) => ({
				clientId: `c${i}`,
				owner,
				path: "/api/families/f1/messages",
				payload: { body: "hi" },
				queuedAt: 1,
			})),
		),
	);
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	expect(view.getByRole("status").textContent).toBe(text);
});
