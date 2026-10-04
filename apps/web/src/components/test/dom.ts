// Test helpers for rendering components in a happy-dom document. `bun test` runs every package's
// tests in one process, so the DOM globals (which also replace `fetch`, `Response`, and others)
// exist only while a component test file runs: `installDom()` installs them before the file's
// tests and removes them after. A component test starts with `import "../test/setup";` and takes
// `render`, `fireEvent`, and the other Testing Library exports from this module.

import { afterAll, afterEach, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setSessionToken } from "@/lib/session";
import { registerDom } from "./setup";

// Bun evaluates CommonJS packages such as React DOM when it links the static imports, before
// `./setup` runs. React DOM decides at load whether it runs in a browser (for example, whether text
// inputs fire `onChange`), so it must load after the DOM globals exist: a dynamic import here.
const testingLibrary = await import("@testing-library/react");
export const { act, cleanup, fireEvent, render, renderHook, waitFor, within } =
	testingLibrary;

export type Call = {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
};

/** A reply: a JSON body with status 200, or an explicit status and body (`undefined` = no body). */
export type ServerReply =
	| { readonly status: number; readonly body?: unknown }
	| { readonly json: unknown };

/** Maps `"GET /api/path"` to a reply, or to a function of the request body. */
export type Routes = Record<
	string,
	ServerReply | ((call: Call) => ServerReply | Promise<ServerReply>)
>;

/** Call at the top of a component test file. */
export function installDom() {
	beforeAll(async () => {
		registerDom();
		// Dynamic for the same reason as React DOM: the query library checks for `window` on load.
		const { prepareQueryCache } = await import("@/lib/test/query");
		prepareQueryCache();
	});
	afterEach(() => {
		cleanup();
		setSessionToken(null);
		localStorage.clear();
	});
	afterAll(async () => {
		// React's scheduler runs work queued by the last test (such as effects after an update) on
		// the next macrotasks, and that work reads `window`. Let it finish before `window` goes.
		await Bun.sleep(50);
		await GlobalRegistrator.unregister();
	});
}

/**
 * Signs in and answers `fetch` from `routes`; an unknown route answers 404. Returns the calls made,
 * in order. Install it inside a test (after `installDom()`'s setup), not at module level.
 */
export function serve(routes: Routes): Call[] {
	const calls: Call[] = [];
	setSessionToken("token");
	const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const raw = init?.body;
		let body: unknown = raw;
		if (typeof raw === "string") {
			try {
				body = JSON.parse(raw);
			} catch {
				body = raw;
			}
		}
		const call = { method, path: url.pathname + url.search, body };
		calls.push(call);
		init?.signal?.throwIfAborted();
		const route =
			routes[`${method} ${call.path}`] ?? routes[`${method} ${url.pathname}`];
		const reply: ServerReply =
			route === undefined
				? { status: 404, body: { error: "not_found", message: "no route" } }
				: typeof route === "function"
					? await route(call)
					: route;
		if ("json" in reply) return Response.json(reply.json);
		return reply.body === undefined
			? new Response(null, { status: reply.status })
			: Response.json(reply.body, { status: reply.status });
	};
	globalThis.fetch = handler as typeof fetch;
	return calls;
}
