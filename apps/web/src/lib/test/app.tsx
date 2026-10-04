// Renders the real app (root layout, header, family provider, and the route at `path`) against a
// fake server. A test file imports `@/lib/test/dom` statically, then this module and
// `@testing-library/react` with `await import(...)`. Bun evaluates a file's static imports first, and
// react-dom must load after `dom` registers `document` (or it never wires input events), and the app
// after `dom` mocks `@/env`.
import {
	type AnyRoute,
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, type screen as Screen, within } from "@testing-library/react";

import { setSessionToken } from "@/lib/session";
import { Route as rootRoute } from "@/routes/__root";
import { Route as appointments } from "@/routes/appointments";
import { Route as bedtime } from "@/routes/bedtime";
import { Route as care } from "@/routes/care";
import { Route as careProfile } from "@/routes/care-profile";
import { Route as chat } from "@/routes/chat";
import { Route as cooking } from "@/routes/cooking";
import { Route as dashboard } from "@/routes/dashboard";
import { Route as family } from "@/routes/family";
import { Route as hud } from "@/routes/hud";
import { Route as index } from "@/routes/index";
import { Route as meal } from "@/routes/meal";
import { Route as medicine } from "@/routes/medicine";
import { Route as reports } from "@/routes/reports";
import { Route as settings } from "@/routes/settings";
import { Route as signInRoute } from "@/routes/sign-in";
import { Route as trends } from "@/routes/trends";
import { Route as trip } from "@/routes/trip";

// The tree the router plugin writes to the gitignored `routeTree.gen.ts`. `bun test` cannot use that
// file: only the Vite build generates it.
const fileRoutes = {
	"/": index,
	"/appointments": appointments,
	"/bedtime": bedtime,
	"/care": care,
	"/care-profile": careProfile,
	"/chat": chat,
	"/cooking": cooking,
	"/dashboard": dashboard,
	"/family": family,
	"/hud": hud,
	"/meal": meal,
	"/medicine": medicine,
	"/reports": reports,
	"/settings": settings,
	"/sign-in": signInRoute,
	"/trends": trends,
	"/trip": trip,
};
// `update` types only the options a route file may set; `id`, `path`, and the parent are what the
// generated tree adds, so the cast mirrors `routeTree.gen.ts`.
export const routeTree = rootRoute.addChildren(
	Object.entries<AnyRoute>(fileRoutes).map(([path, route]) =>
		route.update({ id: path, path, getParentRoute: () => rootRoute } as never),
	),
);

export const FAMILY = {
	id: "fam-1",
	name: "Grandma Rose",
	createdAt: "2026-10-01T00:00:00.000Z",
};

// testing-library's own `screen` binds to the `document` that existed when it first loaded, and each
// test file registers a new one, so this one looks the document up on every use. The cast is safe:
// `within(document.body)` has every query of `screen`.
const emptyScreen = {} as typeof Screen;
export const screen = new Proxy(emptyScreen, {
	get: (_, key) => Reflect.get(within(document.body), key),
});

/** An unsigned ID token for `user-1` that expires in an hour; the client reads its claims only. */
export const signedInToken = (claims: object = {}) =>
	`h.${Buffer.from(
		JSON.stringify({
			iss: "https://issuer.test",
			sub: "user-1",
			exp: Math.floor(Date.now() / 1000) + 3600,
			...claims,
		}),
	).toString("base64url")}.s`;

export const signIn = (claims: object = {}) =>
	setSessionToken(signedInToken(claims));

export type Call = {
	readonly method: string;
	/** The path with its query string, without the origin. */
	readonly path: string;
	/** The JSON-parsed body, the raw body when it is not JSON, or null. */
	readonly body: unknown;
	readonly headers: Headers;
};

export const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/**
 * Replaces `fetch` with a fake server and returns the recorded calls. Keys are `"METHOD /path"`; a
 * key with the query string wins over one without. The origin is ignored. A value is a `Response`,
 * a function of the call (returning a `Response` or a JSON body), or a JSON body sent with 200. A
 * request with no key gets a 404 `ApiError`, so the screen shows its error instead of hanging.
 */
export function serve(routes: Record<string, unknown>): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const raw = init?.body;
			let body: unknown = raw ?? null;
			if (typeof raw === "string") {
				try {
					body = JSON.parse(raw);
				} catch {
					body = raw;
				}
			}
			const call: Call = {
				method: (init?.method ?? "GET").toUpperCase(),
				path: `${url.pathname}${url.search}`,
				body,
				headers: new Headers(init?.headers),
			};
			calls.push(call);
			const reply =
				routes[`${call.method} ${call.path}`] ??
				routes[`${call.method} ${url.pathname}`];
			if (reply === undefined)
				return json(404, { error: "not_found", message: `No ${call.path}` });
			const value = typeof reply === "function" ? await reply(call) : reply;
			return value instanceof Response ? value.clone() : json(200, value);
		},
		{ preconnect: () => {} },
	) as typeof fetch;
	return calls;
}

/** Renders the whole app at `path` with an in-memory history. */
export function renderRoute(path: string) {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	return { router, ...render(<RouterProvider router={router} />) };
}
