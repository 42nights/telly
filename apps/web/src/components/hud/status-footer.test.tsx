// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { afterEach, expect, jest, test } from "bun:test";
import type { RenderResult } from "@testing-library/react";

import { setSessionToken } from "@/lib/session";

import { act, render, serve, setupDom } from "../test/dom-routed";
import { StatusBar } from "./status-footer";

setupDom();
// Bun shares React DOM across test files: a static import would load it before Happy DOM.
const { renderToString } = await import("react-dom/server");

const HEALTH = { status: "ok", service: "server" } as const;
const NOT_CONNECTED = {
	sources: [{ source: "noop", status: "not_connected", lastSeenAt: null }],
};
/** The server never answers, so only the phone pane changes. */
const SILENT = { "GET /health": "hang", "GET /api/sources": "hang" } as const;

afterEach(() => {
	Reflect.deleteProperty(navigator, "getBattery");
	Reflect.deleteProperty(navigator, "onLine");
	jest.useRealTimers();
});

/** A pane's words and its tooltip, which keyboard and screen-reader users get through aria-describedby. */
const pane = (view: RenderResult, text: string | RegExp) => {
	const words = view.getByText(text);
	const button = words.closest("button");
	return {
		text: words.textContent,
		detail: document.getElementById(
			button?.getAttribute("aria-describedby") ?? "",
		)?.textContent,
	};
};

const serverLine = (view: RenderResult) =>
	pane(view, /^(Checking the server|Server )/);

test("before the server answers, every pane says what is still unknown", async () => {
	const calls = serve(SILENT);
	const view = render(<StatusBar familyId={null} />);
	expect(serverLine(view)).toEqual({
		text: "Checking the server…",
		detail: "No reply yet.",
	});
	expect(pane(view, "Monitoring off").detail).toBe("No person is selected.");
	expect(pane(view, "WHOOP").detail).toBe("Status unknown.");
	// Glasses are never paired, so they get no pane.
	expect(view.queryByText(/Glasses/)).toBeNull();
	// Happy DOM has no Battery Status API: the battery is unknown, never 0 %.
	expect(pane(view, "Phone online").detail).toBe("Online. Battery unknown.");
	expect(view.queryByRole("status")).toBeNull();
	expect(calls.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
		"GET /api/sources",
		"GET /health",
	]);
});

test("a fresh reply is online, and it turns stale after three missed polls", async () => {
	jest.useFakeTimers();
	const now = Date.now();
	let answered = false;
	serve({
		// The first poll answers; every later one hangs, so the last good reply only gets older.
		"GET /health": () => {
			if (answered) return "hang";
			answered = true;
			return { json: HEALTH };
		},
		"GET /api/sources": {
			json: {
				sources: [
					{
						source: "noop",
						status: "not_connected",
						lastSeenAt: new Date(now - 5 * 3_600_000).toISOString(),
					},
				],
			},
		},
	});
	const view = render(<StatusBar familyId={null} />);
	await act(async () => {});
	expect(pane(view, "WHOOP 5 h ago").detail).toBe(
		"Not connected: no new readings, wear unknown. Last reading 5 h ago.",
	);
	expect(serverLine(view)).toEqual({
		text: "Server online",
		detail: "Last reply 0 s ago.",
	});

	await act(async () => {
		jest.advanceTimersByTime(20_000);
	});
	expect(serverLine(view)).toEqual({
		text: "Server data stale",
		detail: "Last reply 20 s ago.",
	});
});

test("a failed read says the server is offline and why", async () => {
	serve({
		"GET /health": { status: 500, json: { error: "boom", message: "boom" } },
		"GET /api/sources": "network-error",
	});
	const view = render(<StatusBar familyId={null} />);
	expect(await view.findByText("Server offline")).toBeDefined();
	expect(serverLine(view).detail).toBe(
		"GET http://server.test/health failed with HTTP 500. No reply yet.",
	);
	expect(pane(view, "WHOOP").detail).toBe("Status unknown.");
});

test("no configured source is reported as not set up", async () => {
	serve({
		"GET /health": { json: HEALTH },
		"GET /api/sources": { json: { sources: [] } },
	});
	const view = render(<StatusBar familyId={null} />);
	expect(await view.findByText("WHOOP not set up")).toBeDefined();
	expect(pane(view, "WHOOP not set up").detail).toBe("No source configured.");
});

const token = `h.${Buffer.from(JSON.stringify({ iss: "https://id.test", sub: "wearer", exp: 4e9 })).toString("base64url")}.s`;

test("monitoring shows the selected person's level, never on without a fresh reading", async () => {
	setSessionToken(token);
	const rule = (state: string) => ({
		threshold: {
			id: state,
			familyId: "f1",
			metric: "heart_rate",
			direction: "above",
			limit: 120,
			unit: "bpm",
			maxAgeSeconds: 600,
			updatedBy: "a",
			updatedAt: "2026-01-01T00:00:00Z",
		},
		state,
		reason: state === "unavailable" ? "stale" : null,
		sample: null,
	});
	serve({
		...SILENT,
		"GET /api/families/f1/monitoring": {
			json: {
				checkedAt: "2026-01-01T00:00:00Z",
				thresholds: [rule("in_range"), rule("unavailable")],
			},
		},
	});
	const view = render(<StatusBar familyId="f1" />);
	expect(await view.findByText("Monitoring partial")).toBeDefined();
	expect(pane(view, "Monitoring partial").detail).toBe(
		"Some thresholds have no fresh reading, so an alert could be missed.",
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
	const view = render(<StatusBar familyId={null} />);
	await act(async () => {});
	expect(serverLine(view).text).toBe("Server online");

	healthy = false;
	await act(async () => {
		jest.advanceTimersByTime(5_000);
	});
	expect(serverLine(view)).toEqual({
		text: "Server offline",
		detail: expect.stringMatching(/ Last reply [56] s ago\.$/),
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
	render(<StatusBar familyId={null} />);
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

test("the phone pane shows the battery level and follows its changes", async () => {
	serve(SILENT);
	const manager = Object.assign(new EventTarget(), {
		level: 0.42,
		charging: false,
	});
	Object.defineProperty(navigator, "getBattery", {
		configurable: true,
		value: async () => manager,
	});
	const view = render(<StatusBar familyId={null} />);
	expect(pane(view, "Phone online").detail).toBe("Online. Battery: checking…");
	expect(await view.findByText("Phone 42 %")).toBeDefined();
	act(() => {
		manager.level = 0.5;
		manager.charging = true;
		manager.dispatchEvent(new Event("chargingchange"));
	});
	expect(pane(view, "Phone 50 %").detail).toBe(
		"Online. Battery 50 %, charging.",
	);
});

test("going offline says what waits, and coming back online clears it", () => {
	serve(SILENT);
	let online = true;
	Object.defineProperty(navigator, "onLine", {
		configurable: true,
		get: () => online,
	});
	const view = render(<StatusBar familyId={null} />);
	act(() => {
		online = false;
		window.dispatchEvent(new Event("offline"));
	});
	expect(pane(view, "Phone offline").detail).toBe(
		"Offline: answers, directions, and messages wait. Battery unknown.",
	);
	act(() => {
		online = true;
		window.dispatchEvent(new Event("online"));
	});
	expect(view.getByText("Phone online")).toBeDefined();
});

test("a server-rendered bar assumes online and still checks battery and server", () => {
	const html = renderToString(<StatusBar familyId={null} />);
	expect(html).toContain("Phone online");
	expect(html).toContain("Battery: checking…");
	expect(html).toContain("Checking the server…");
	expect(html).not.toContain("waiting");
});

test.each([
	[1, "1 waiting", "1 action is saved on this phone."],
	[2, "2 waiting", "2 actions are saved on this phone."],
])(
	"%i saved action(s) of the signed-in wearer are counted",
	(count, text, saved) => {
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
		const view = render(<StatusBar familyId={null} />);
		expect(view.getByRole("status").contains(view.getByText(text))).toBe(true);
		expect(pane(view, text).detail).toBe(
			`${saved} They are sent once when the connection returns.`,
		);
	},
);
