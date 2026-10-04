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

/** A chip's visible words and its tooltip, which screen readers get through aria-describedby. */
const chip = (element: HTMLElement) => ({
	text: [...element.childNodes]
		.filter((node) => node.nodeType === Node.TEXT_NODE)
		.map((node) => node.textContent)
		.join(""),
	detail: document.getElementById(
		element.getAttribute("aria-describedby") ?? "",
	)?.textContent,
});

const serverLine = (view: RenderResult) =>
	chip(view.getByText(/^(Checking the server|Server )/));

test("before the server answers, every chip says what is still unknown", async () => {
	const calls = serve(SILENT);
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	expect(serverLine(view)).toEqual({
		text: "Checking the server…",
		detail: "No reply yet.",
	});
	expect(chip(view.getByText("Monitoring: checking…")).detail).toBe(
		"Asking the server.",
	);
	expect(chip(view.getByText("WHOOP")).detail).toBe("Status unknown.");
	expect(chip(view.getByText("Glasses not paired")).detail).toBe(
		"Optional: nothing needs them.",
	);
	// Happy DOM has no Battery Status API: the battery is unknown, never 0 %.
	expect(chip(view.getByText("Phone online")).detail).toBe("Battery unknown");
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
	expect(serverLine(view)).toEqual({
		text: "Server online",
		detail: "Last reply 0 s ago.",
	});
	expect(chip(view.getByText("WHOOP not connected")).detail).toBe(
		"No new readings; wear unknown. Last reading 1 h ago. Saved, not current.",
	);

	view.rerender(<StatusFooter now={now + 20_000} records={records} />);
	expect(serverLine(view).text).toBe("Server data stale");
	expect(serverLine(view).detail).toMatch(/^Last reply (19|20) s ago\.$/);
});

test("a failed read says the server is unavailable and why", async () => {
	serve({
		"GET /health": { status: 500, json: { error: "boom", message: "boom" } },
		"GET /api/sources": "network-error",
	});
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	expect(chip(await view.findByText("Monitoring: unknown")).detail).toBe(
		"The server did not answer.",
	);
	expect(serverLine(view)).toEqual({
		text: "Server offline",
		detail: "GET http://server.test/health failed with HTTP 500. No reply yet.",
	});
});

test("no configured source is reported as stopped, not as watched", async () => {
	serve({
		"GET /health": { json: HEALTH },
		"GET /api/sources": { json: { sources: [] } },
	});
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	expect(chip(await view.findByText("Monitoring: stopped")).detail).toBe(
		"No health source configured.",
	);
	expect(chip(view.getByText("WHOOP not set up")).detail).toBe(
		"No source configured.",
	);
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
	expect(serverLine(view).text).toBe("Server online");

	healthy = false;
	await act(async () => {
		jest.advanceTimersByTime(5_000);
	});
	view.rerender(<StatusFooter now={start + 6_000} records={null} />);
	expect(serverLine(view)).toEqual({
		text: "Server offline",
		detail: expect.stringMatching(/ Last reply 6 s ago\.$/),
	});
	expect(calls.filter(({ path }) => path === "/health")).toHaveLength(2);

	view.unmount();
	jest.advanceTimersByTime(15_000);
	expect(calls.filter(({ path }) => path === "/health")).toHaveLength(2);
});

test("a read still pending at the next poll is cancelled", async () => {
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
	const phone = () => chip(view.getByText(/^Phone /)).detail;
	expect(phone()).toBe("Battery: checking…");
	await act(async () => {});
	expect(phone()).toBe("Battery 42 %");
	act(() => {
		manager.level = 0.5;
		manager.charging = true;
		manager.dispatchEvent(new Event("chargingchange"));
	});
	expect(phone()).toBe("Battery 50 %, charging");
});

test("a battery read that fails reports the battery unknown", async () => {
	serve(SILENT);
	Object.defineProperty(navigator, "getBattery", {
		configurable: true,
		value: () => Promise.reject(new Error("blocked")),
	});
	const view = render(<StatusFooter now={Date.now()} records={null} />);
	await act(async () => {});
	expect(chip(view.getByText("Phone online")).detail).toBe("Battery unknown");
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
	expect(chip(view.getByText("Phone offline")).detail).toBe(
		"Answers, directions, and messages wait. Battery unknown",
	);
	act(() => {
		online = true;
		window.dispatchEvent(new Event("online"));
	});
	expect(chip(view.getByText("Phone online")).detail).toBe("Battery unknown");
});

test("a server-rendered footer assumes online and still checks battery and server", () => {
	const html = renderToString(<StatusFooter now={0} records={null} />);
	expect(html).toContain("Phone online");
	expect(html).toContain("Battery: checking…");
	expect(html).toContain("Checking the server…");
	expect(html).not.toContain("waiting");
});

const token = `h.${Buffer.from(JSON.stringify({ iss: "https://id.test", sub: "wearer", exp: 4e9 })).toString("base64url")}.s`;

test.each([
	[1, "1 action waiting"],
	[2, "2 actions waiting"],
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
	const status = view.getByRole("status");
	expect(chip(view.getByText(text)).detail).toBe(
		"Saved on this phone. Sent once when the connection returns.",
	);
	expect(status.contains(view.getByText(text))).toBe(true);
});
