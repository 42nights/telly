import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import type { Root } from "react-dom/client";

import { setupDom } from "@/lib/test/dom";

setupDom();

// The test harness builds the route tree itself; `./routeTree.gen` exists only after a Vite build.
// main.tsx runs once per import, so each case loads its own copy (`?case`).
// Bun's coverage keeps one copy of main.tsx, the last loaded, so the mount case runs last.
// testing-library loads react-dom, which must see `document` to wire its events: import it after `dom`.
const { act, waitFor } = await import("@testing-library/react");
const { routeTree, screen, serve, signIn } = await import("@/lib/test/app");
mock.module("./routeTree.gen", () => ({ routeTree }));

// Bun runs every test file in one process, so the app that main.tsx mounts must not keep polling
// and syncing into later files: keep its root and its sync, and stop them after each case, while
// the page still exists.
const { default: ReactDOM } = await import("react-dom/client");
const pending = await import("@/lib/pending");
const { createRoot } = ReactDOM;
const { startPendingSync } = pending;
const roots: Root[] = [];
const stops: (() => void)[] = [];
const rootSpy = spyOn(ReactDOM, "createRoot").mockImplementation(
	(container, options) => {
		const root = createRoot(container, options);
		roots.push(root);
		return root;
	},
);
const syncSpy = spyOn(pending, "startPendingSync").mockImplementation(() => {
	const stop = startPendingSync();
	stops.push(stop);
	return stop;
});
afterEach(() => {
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	for (const stop of stops.splice(0)) stop();
});
afterAll(() => {
	rootSpy.mockRestore();
	syncSpy.mockRestore();
});

// A copy of main.tsx per case. The specifier is not a literal so TypeScript does not resolve it.
const main = "./main";
const load = (copy: string) => import(`${main}?${copy}`);

test("leaves a page that already has content alone", async () => {
	document.body.innerHTML = '<div id="app"><p>prerendered</p></div>';
	const calls = serve({});

	await load("prerendered");

	expect(document.getElementById("app")?.innerHTML).toBe("<p>prerendered</p>");
	expect(calls).toEqual([]);
});

test("fails loudly when the page has no #app element", async () => {
	document.body.innerHTML = "";
	await expect(load("missing")).rejects.toThrow("Root element not found");
});

test("mounts the app into #app and sends actions saved before the page loaded", async () => {
	signIn();
	localStorage.setItem(
		"telly.pending",
		JSON.stringify([
			{
				clientId: "c-1",
				owner: "https://issuer.test user-1",
				path: "/api/families/fam-1/messages",
				payload: { body: "On my way" },
				queuedAt: 1,
			},
		]),
	);
	const calls = serve({
		"GET /api/families": { families: [] },
		"POST /api/families/fam-1/messages": new Response(null, { status: 204 }),
	});
	document.body.innerHTML = '<div id="app"></div>';

	await load("mount");

	expect(
		await screen.findByRole("navigation", { name: "Screens" }),
	).toBeTruthy();
	await waitFor(() => expect(localStorage.getItem("telly.pending")).toBeNull());
	const sent = calls.find((call) => call.method === "POST");
	expect(sent?.body).toEqual({ body: "On my way", clientId: "c-1" });
});
