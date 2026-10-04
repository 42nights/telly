// Shared setup for component tests. Import this module FIRST in a test file (it registers Happy DOM
// through `./register`), then call `setupDom()` at the top level. Happy DOM replaces globals such as
// `fetch` and `Response`, so each file removes it after its tests; other packages' tests run without it.
// A side-effect import is never reordered, so Happy DOM is registered before the imports below load.
import "./register";

import { afterAll, afterEach, mock, setDefaultTimeout } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { setSessionToken } from "@/lib/session";

import { registerDom } from "./register";

// Testing Library loads React DOM. Bun evaluates a CommonJS module such as React DOM while it links
// static imports, before `./register` runs, and React DOM checks for `document` once, when it loads
// (without it, `onChange` never fires for text inputs). Bun shares that module across test files,
// so a static import in any test file breaks every later one. Import these from here only.
const { cleanup, configure, ...rtl } = await import("@testing-library/react");
export const { act, fireEvent, render, renderHook, waitFor, within } = rtl;

// The shared CI host can be many times slower than a laptop, so allow slow hosts the time they need
// (the 1 s Testing Library and 5 s Bun defaults failed there). Keep a failed query cheap: by default
// each failed retry of `findBy` and `waitFor` formats the whole DOM, which slows a loaded host more.
configure({
	asyncUtilTimeout: 10_000,
	getElementError: (message, container) => {
		const error = new Error(
			`${message}\n\nPage text: ${container.textContent?.slice(0, 2_000)}`,
		);
		error.name = "TestingLibraryElementError";
		return error;
	},
});

const SERVER = "http://server.test";

export type Call = {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
};

export type Reply =
	| { readonly status?: number; readonly json?: unknown; readonly blob?: Blob }
	| "network-error"
	| "hang";

type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

/**
 * Answers `fetch` from `routes`, keyed `"GET /api/x"` (the path includes its query). An unknown
 * route answers 404. `"hang"` waits until the request aborts. Returns the calls in order, so a test
 * can assert what was sent.
 */
export const serve = (routes: Record<string, Handler>): Call[] => {
	const calls: Call[] = [];
	const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const path = `${url.pathname}${url.search}`;
		let body: unknown = init?.body;
		if (typeof body === "string") {
			try {
				body = JSON.parse(body);
			} catch {}
		}
		const call = { method, path, body };
		calls.push(call);
		const handler = routes[`${method} ${path}`];
		const reply =
			handler === undefined
				? { status: 404, json: { error: "not_found", message: "no route" } }
				: typeof handler === "function"
					? await handler(call)
					: handler;
		if (reply === "network-error") throw new TypeError("Failed to fetch");
		if (reply === "hang")
			return new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				),
			);
		const status = reply.status ?? 200;
		if (reply.blob !== undefined) return new Response(reply.blob, { status });
		return new Response(
			status === 204 ? null : JSON.stringify(reply.json ?? null),
			{ status, headers: { "Content-Type": "application/json" } },
		);
	};
	globalThis.fetch = Object.assign(fake, { preconnect: () => {} });
	return calls;
};

/** Signs in with an opaque token (no `exp`, so it never expires). */
export const signIn = () => setSessionToken("test-token");

/**
 * Registers Happy DOM for this file, mocks `@/env` (the generated module needs varlock at runtime;
 * tests need only the server URL), and resets the page, storage, and session after each test.
 * Bun applies `mock.module` to an already imported module only from the test file's top level.
 */
export const setupDom = () => {
	mock.module("@/env", () => ({ ENV: { VITE_SERVER_URL: SERVER } }));
	registerDom();
	setDefaultTimeout(30_000);
	const realFetch = globalThis.fetch;
	afterEach(() => {
		cleanup();
		globalThis.fetch = realFetch;
		setSessionToken(null);
		localStorage.clear();
		sessionStorage.clear();
	});
	afterAll(async () => {
		// React runs work left by the last test (such as unmount effects) on its next scheduler
		// tick; that work reads `window`, so it must run before Happy DOM is removed.
		await Bun.sleep(20);
		await GlobalRegistrator.unregister();
	});
};

/** Renders `node` inside a TanStack router at `path`, so `Link` and navigation work. */
export const renderRouted = async (node: ReactNode, path = "/") => {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => node }),
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	await router.load();
	return { view: render(<RouterProvider router={router} />), router };
};
