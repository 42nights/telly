// The one client for the authenticated server API. Every reply is decoded with its shared contract,
// and every failure keeps its meaning: signed out, not a member, provider unavailable, or an error.
// A failure is never turned into empty data.
import { ApiError } from "@health/contracts";
import { Schema } from "effect";
import { useEffect, useState } from "react";

import { ENV } from "@/env";

import { getSessionToken, onSessionChange } from "./session";

export type ApiFailure =
	/** No sign-in token, or the server rejected it (401). */
	| { readonly kind: "signed_out" }
	/** Signed in, but not a member of this family (403). */
	| { readonly kind: "forbidden"; readonly message: string }
	/** A provider or the database is not configured or not reachable (503). */
	| { readonly kind: "unavailable"; readonly message: string }
	/** The server could not be reached (`unreachable`), or it replied with something else. */
	| {
			readonly kind: "error";
			readonly message: string;
			readonly unreachable?: true;
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
	const message =
		error._tag === "Some" ? error.value.message : `HTTP ${status}`;
	if (status === 401) return { kind: "signed_out" };
	if (status === 403) return { kind: "forbidden", message };
	if (status === 503) return { kind: "unavailable", message };
	return { kind: "error", message };
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
	const token = getSessionToken();
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
	if (!response.ok)
		return failureFor(
			response.status,
			await response.json().catch(() => undefined),
		);
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
	const token = getSessionToken();
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
		if (!response.ok)
			return failureFor(
				response.status,
				await response.json().catch(() => undefined),
			);
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
 * Reads `path` with `schema`, again every `pollMs` when given, and again when the session changes.
 * `path === null` skips the read (for example, no family is selected yet). A failed re-read keeps
 * its failure visible: the last good value is not shown as current. A new `path` (such as another
 * selected person) shows loading until its own reply: one person's data never shows as another's.
 */
export function useApi<T>(
	schema: Schema.Decoder<T>,
	path: string | null,
	options: { readonly pollMs?: number; readonly refreshKey?: unknown } = {},
): ApiState<T> {
	const [read, setRead] = useState<{
		readonly path: string;
		readonly state: ApiState<T>;
	} | null>(null);
	const { pollMs, refreshKey } = options;
	useEffect(() => {
		void refreshKey;
		if (path === null) return;
		let controller = new AbortController();
		const load = () => {
			controller.abort();
			controller = new AbortController();
			const { signal } = controller;
			apiRequest(schema, path, { signal })
				.then((result) => {
					if (signal.aborted) return;
					setRead({
						path,
						state:
							result.kind === "ready" ? { ...result, at: Date.now() } : result,
					});
				})
				.catch(() => {});
		};
		load();
		const stop = onSessionChange(load);
		const timer = pollMs === undefined ? undefined : setInterval(load, pollMs);
		return () => {
			stop();
			clearInterval(timer);
			controller.abort();
		};
	}, [schema, path, pollMs, refreshKey]);
	return read !== null && read.path === path ? read.state : { kind: "loading" };
}

/** A path inside one family: `familyPath("123", "/alerts")` is `/api/families/123/alerts`. */
export const familyPath = (familyId: string, path = "") =>
	`/api/families/${encodeURIComponent(familyId)}${path}`;
