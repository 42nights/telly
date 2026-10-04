// The one client for the authenticated server API. Every reply is decoded with its shared contract,
// and every failure keeps its meaning: signed out, not a member, provider unavailable, or an error.
// A failure is never turned into empty data.
import { ApiError } from "@health/contracts";
import { onlineManager, queryOptions, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

import { ENV } from "@/env";

import {
	apiKey,
	invalidateAfterWrite,
	queryClient,
	staleTimeFor,
} from "./query";
import { freshSessionToken, getSessionToken, setSessionToken } from "./session";

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
	return { kind: "error", message };
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
	// The write is stored even when its reply does not decode.
	if ((options.method ?? "GET") !== "GET") invalidateAfterWrite(path);
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

/** A failed read, kept as its query's error. */
export class ApiReadError extends Error {
	constructor(readonly failure: ApiFailure) {
		super(failure.kind === "signed_out" ? "Signed out" : failure.message);
	}
}

/** The failure a query's error stands for. */
export const failureOf = (error: unknown): ApiFailure =>
	error instanceof ApiReadError
		? error.failure
		: { kind: "error", message: String(error) };

/**
 * The cached read of `path` with `schema`: one query per path, current for `staleTimeFor`, and
 * read again every `pollMs` when given. A polled read that takes longer than `pollMs` fails. Route
 * loaders pass it to `ensureQueryData`; screens read it with `useApi`.
 */
export const apiQuery = <T>(
	schema: Schema.Decoder<T>,
	path: string,
	pollMs?: number,
) => {
	const queryKey = apiKey(path);
	return queryOptions({
		queryKey,
		queryFn: async ({ signal }): Promise<T> => {
			let result: ApiResult<T>;
			try {
				result = await apiRequest(schema, path, {
					signal:
						pollMs === undefined
							? signal
							: AbortSignal.any([signal, AbortSignal.timeout(pollMs)]),
				});
			} catch (error) {
				// Only the timeout gets here without the query being cancelled.
				if (signal.aborted) throw error;
				result = {
					kind: "error",
					message: "The server did not answer in time.",
					unreachable: true,
				};
			}
			if (result.kind !== "ready") throw new ApiReadError(result);
			return result.value;
		},
		staleTime: staleTimeFor(queryKey, pollMs),
		refetchInterval: pollMs ?? false,
		refetchOnWindowFocus: pollMs !== undefined,
	});
};

// Stable, so `useSyncExternalStore` subscribes once.
const subscribeOnline = (listener: () => void) =>
	onlineManager.subscribe(listener);

/**
 * Reads `path` with `schema` from the cache (see `apiQuery`). `path === null` skips the read (for
 * example, no family is selected yet). A cached value shows at once and reads again in the
 * background when it is no longer current. A failed re-read keeps its failure visible: the last
 * good value is not shown as current. A new `path` (such as another selected person) shows loading
 * until its own reply: one person's data never shows as another's.
 *
 * On a phone the screen can come back from the background, or lose its network, with an old value
 * still on it. So a lost network shows a failure at once, and a return to the network reads again.
 * A polled value older than two polls is not shown while its re-read runs.
 */
export function useApi<T>(
	schema: Schema.Decoder<T>,
	path: string | null,
	options: { readonly pollMs?: number } = {},
): ApiState<T> {
	const { pollMs } = options;
	const online = useSyncExternalStore(subscribeOnline, () =>
		onlineManager.isOnline(),
	);
	const query = useQuery(
		{ ...apiQuery(schema, path ?? "", pollMs), enabled: path !== null },
		queryClient,
	);
	if (path === null || query.status === "pending") return { kind: "loading" };
	if (!online)
		return {
			kind: "error",
			message:
				"This phone has no network connection, so the last values may not be current.",
			unreachable: true,
		};
	if (query.status === "error") return failureOf(query.error);
	if (
		pollMs !== undefined &&
		query.isFetching &&
		Date.now() - query.dataUpdatedAt > 2 * pollMs
	)
		return {
			kind: "error",
			message: "These values are old. Checking for current values.",
		};
	return { kind: "ready", value: query.data, at: query.dataUpdatedAt };
}

/** Reads `path` again now, for a "Try again" button. */
export const reread = (path: string) =>
	queryClient.invalidateQueries({ queryKey: apiKey(path), exact: true });

/** A path inside one family: `familyPath("123", "/alerts")` is `/api/families/123/alerts`. */
export const familyPath = (familyId: string, path = "") =>
	`/api/families/${encodeURIComponent(familyId)}${path}`;
