// The one client for the authenticated server API. Every reply is decoded with its shared contract,
// and every failure keeps its meaning: signed out, not a member, provider unavailable, or an error.
// A failure is never turned into empty data.
import { ApiError } from "@health/contracts";
import { Schema } from "effect";
import { useEffect, useState } from "react";

import { ENV } from "@/env";

import {
	freshSessionToken,
	getSessionToken,
	onSessionChange,
	setSessionToken,
} from "./session";

export type ApiFailure =
	/** No sign-in token, or the server rejected it (401). */
	| { readonly kind: "signed_out" }
	/** Signed in, but not a member of this family (403). */
	| { readonly kind: "forbidden"; readonly message: string }
	/** A provider or the database is not configured or not reachable (503). */
	| { readonly kind: "unavailable"; readonly message: string }
	/** The server could not be reached (`unreachable`), or it replied with something else (`status`). */
	| {
			readonly kind: "error";
			readonly message: string;
			readonly unreachable?: true;
			readonly status?: number;
	  };

export type ApiResult<T> =
	| { readonly kind: "ready"; readonly value: T }
	| ApiFailure;

export type ApiState<T> =
	| { readonly kind: "loading" }
	| ({ readonly kind: "ready"; readonly value: T } & {
			/** `Date.now()` when this value was decoded. */
			readonly at: number;
	  })
	| ApiFailure;

const decodeError = Schema.decodeUnknownOption(ApiError);

/** Maps a non-2xx reply to its failure. Exported for tests. */
export const failureFor = (status: number, body: unknown): ApiFailure => {
	const error = decodeError(body);
	// A 5xx without the typed body comes from a proxy or gateway, not from the API's own handlers.
	const message =
		error._tag === "Some"
			? error.value.message
			: status >= 500
				? `The server is busy or had a problem (HTTP ${status}). Try again in a minute.`
				: `HTTP ${status}`;
	if (status === 401) return { kind: "signed_out" };
	if (status === 403) return { kind: "forbidden", message };
	if (status === 503) return { kind: "unavailable", message };
	return { kind: "error", message, status };
};

/** A non-2xx reply's failure. A 401 means the server rejected `token`, so it ends the session. */
const replyFailure = async (response: Response, token: string) => {
	if (response.status === 401 && getSessionToken() === token)
		setSessionToken(null);
	return failureFor(
		response.status,
		await response.json().catch(() => undefined),
	);
};

type RequestOptions = {
	readonly method?: "GET" | "POST" | "PUT" | "DELETE";
	/** JSON body, or a raw body (such as a recording) sent with its own Content-Type. */
	readonly body?: unknown;
	readonly rawBody?: { readonly data: Blob; readonly type: string };
	readonly signal?: AbortSignal;
};

/**
 * Calls `path` (such as `/api/families`) and decodes a 2xx JSON reply with `schema`. Pass `null` as
 * the schema for replies without a body (204). Never rejects, except when `signal` aborts.
 */
export const apiRequest = async <T>(
	schema: Schema.Decoder<T> | null,
	path: string,
	options: RequestOptions = {},
): Promise<ApiResult<T>> => {
	const token = await freshSessionToken();
	if (token === null) return { kind: "signed_out" };
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	let body: BodyInit | undefined;
	if (options.rawBody !== undefined) {
		headers["Content-Type"] = options.rawBody.type;
		body = options.rawBody.data;
	} else if (options.body !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(options.body);
	}
	let response: Response;
	try {
		response = await fetch(`${ENV.VITE_SERVER_URL}${path}`, {
			method: options.method ?? "GET",
			headers,
			...(body === undefined ? {} : { body }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return {
			kind: "error",
			message: `The server is not reachable: ${error}`,
			unreachable: true,
		};
	}
	if (!response.ok) return replyFailure(response, token);
	if (schema === null) return { kind: "ready", value: undefined as T };
	try {
		return {
			kind: "ready",
			value: await Schema.decodeUnknownPromise(schema)(await response.json()),
		};
	} catch (error) {
		return {
			kind: "error",
			message: `The server sent an unexpected reply: ${error}`,
		};
	}
};

/** Fetches a binary reply (such as speech audio). Same failure mapping as `apiRequest`. */
export const apiBlob = async (
	path: string,
	options: RequestOptions = {},
): Promise<ApiResult<Blob>> => {
	const token = await freshSessionToken();
	if (token === null) return { kind: "signed_out" };
	try {
		const response = await fetch(`${ENV.VITE_SERVER_URL}${path}`, {
			method: options.method ?? "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(options.body),
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		if (!response.ok) return replyFailure(response, token);
		return { kind: "ready", value: await response.blob() };
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return {
			kind: "error",
			message: `The server is not reachable: ${error}`,
			unreachable: true,
		};
	}
};

/**
 * How long a starting API gets before its failure shows: a cold container start takes about 35 s,
 * and the Worker gives up after 60 s. Screen tests that check failure notices set it to 0.
 */
export const apiStart = { windowMs: 60_000 };

/** A failure that means the API may still be starting, not that it refused or broke. */
const coldStart = (failure: ApiFailure) =>
	(failure.kind === "error" && failure.unreachable === true) ||
	(failure.kind === "unavailable" &&
		failure.message === "The API did not start");

/**
 * Retries while the API may be starting: after 1, 2, 4, then every 8 s, until `windowMs` has passed
 * since the first failure. `schedule` is false once the window is over; `reset` after a success.
 */
type StartRetry = {
	readonly schedule: () => boolean;
	readonly reset: () => void;
	readonly cancel: () => void;
};

const startRetry = (windowMs: number, retry: () => void): StartRetry => {
	let since: number | undefined;
	let attempt = 0;
	let timer: number | undefined;
	return {
		schedule: () => {
			since ??= Date.now();
			if (Date.now() - since >= windowMs) return false;
			window.clearTimeout(timer);
			timer = window.setTimeout(retry, Math.min(1000 * 2 ** attempt++, 8000));
			return true;
		},
		reset: () => {
			since = undefined;
			attempt = 0;
		},
		cancel: () => window.clearTimeout(timer),
	};
};

/** The state a finished read shows, or undefined while a starting API is retried (`waiting`). */
const settled = <T>(
	result: ApiResult<T>,
	retry: StartRetry,
	waiting: () => void,
): ApiState<T> | undefined => {
	if (result.kind === "ready") {
		retry.reset();
		return { ...result, at: Date.now() };
	}
	if (coldStart(result) && retry.schedule()) {
		waiting();
		return undefined;
	}
	return result;
};

/**
 * Reads `path` with `schema`, again every `pollMs` when given, and again when the session changes.
 * `path === null` skips the read (for example, no family is selected yet). A failed re-read keeps
 * its failure visible: the last good value is not shown as current. A new `path` (such as another
 * selected person) shows loading until its own reply: one person's data never shows as another's.
 *
 * On a phone the screen can come back from the background, or lose its network, with an old value
 * still on it. So a lost network shows a failure at once, a polled read that takes longer than
 * `pollMs` fails, and a return to the screen or to the network reads again. A value older than two
 * polls is not shown while that read runs.
 *
 * The API container starts in about 35 s after a deploy or an idle period (the Worker waits up to
 * 60 s, then answers 503 "The API did not start"). So a read that times out, cannot reach the
 * server, or gets that 503 is retried with backoff and shows loading ("Waiting for the server") for
 * up to `connectMs` from the first such failure; only then does the failure show.
 */
export function useApi<T>(
	schema: Schema.Decoder<T>,
	path: string | null,
	options: {
		readonly pollMs?: number;
		readonly refreshKey?: unknown;
		/** How long a server that is starting gets before its failure shows. Tests shorten it. */
		readonly connectMs?: number;
	} = {},
): ApiState<T> {
	const [read, setRead] = useState<{
		readonly path: string;
		readonly state: ApiState<T>;
	} | null>(null);
	const { pollMs, refreshKey, connectMs = apiStart.windowMs } = options;
	useEffect(() => {
		void refreshKey;
		if (path === null) return;
		let controller = new AbortController();
		// A poll waits for the read in flight, so a slow read can finish and a hung one can time out.
		let pending = false;
		// Both local failures (no network, no answer in time) mean the server was not reached.
		const fail = (message: string) =>
			setRead({ path, state: { kind: "error", message, unreachable: true } });
		const retry = startRetry(connectMs, () => load());
		// While the server may be starting, the screen shows loading ("Waiting for the server").
		const waiting = () => setRead({ path, state: { kind: "loading" } });
		const load = () => {
			retry.cancel();
			controller.abort();
			controller = new AbortController();
			const { signal } = controller;
			pending = true;
			apiRequest(schema, path, {
				signal:
					pollMs === undefined
						? signal
						: AbortSignal.any([signal, AbortSignal.timeout(pollMs)]),
			})
				.then((result) => {
					if (signal.aborted) return;
					const state = settled(result, retry, waiting);
					if (state !== undefined) setRead({ path, state });
				})
				.catch(() => {
					// Only the timeout gets here without this read being replaced or unmounted.
					if (signal.aborted) return;
					if (retry.schedule()) waiting();
					else fail("The server did not answer in time.");
				})
				.finally(() => {
					if (!signal.aborted) pending = false;
				});
		};
		const offline = () =>
			fail(
				"This phone has no network connection, so the last values may not be current.",
			);
		const resume = () => {
			if (document.visibilityState !== "visible") return;
			setRead((current) =>
				current !== null &&
				current.state.kind === "ready" &&
				pollMs !== undefined &&
				Date.now() - current.state.at > 2 * pollMs
					? {
							path,
							state: {
								kind: "error",
								message:
									"The app was in the background. Checking for current values.",
							},
						}
					: current,
			);
			load();
		};
		load();
		const stop = onSessionChange(load);
		const timer =
			pollMs === undefined
				? undefined
				: setInterval(() => {
						if (!pending) load();
					}, pollMs);
		window.addEventListener("offline", offline);
		window.addEventListener("online", load);
		document.addEventListener("visibilitychange", resume);
		return () => {
			stop();
			retry.cancel();
			clearInterval(timer);
			window.removeEventListener("offline", offline);
			window.removeEventListener("online", load);
			document.removeEventListener("visibilitychange", resume);
			controller.abort();
		};
	}, [schema, path, pollMs, refreshKey, connectMs]);
	return read !== null && read.path === path ? read.state : { kind: "loading" };
}

/** A path inside one family: `familyPath("123", "/alerts")` is `/api/families/123/alerts`. */
export const familyPath = (familyId: string, path = "") =>
	`/api/families/${encodeURIComponent(familyId)}${path}`;
