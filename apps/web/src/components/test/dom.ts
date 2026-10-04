// Test helpers for rendering components in a happy-dom document. `bun test` runs every package's
// tests in one process, so the DOM globals (which also replace `fetch`, `Response`, and others)
// exist only while a component test file runs: `installDom()` installs them before the file's
// tests and removes them after. A component test starts with `import "../test/env";`.
import "./env";

import { afterAll, afterEach, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";

import { setSessionToken } from "@/lib/session";

export type Call = {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
};

/** A reply: a JSON body with status 200, or an explicit status and body (`undefined` = no body). */
export type Reply =
	| { readonly status: number; readonly body?: unknown }
	| { readonly json: unknown };

/** Maps `"GET /api/path"` to a reply, or to a function of the request body. */
export type Routes = Record<
	string,
	Reply | ((call: Call) => Reply | Promise<Reply>)
>;

/** Call at the top of a component test file. */
export function installDom() {
	beforeAll(() => {
		if (!GlobalRegistrator.isRegistered)
			GlobalRegistrator.register({ url: "http://localhost/" });
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	});
	afterEach(() => {
		cleanup();
		setSessionToken(null);
		localStorage.clear();
	});
	afterAll(async () => {
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
		const reply: Reply =
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
