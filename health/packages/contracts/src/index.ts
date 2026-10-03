import { Schema } from "effect";

/** `GET /health`: process liveness only, not provider or data availability. */
export const Health = Schema.Struct({
	status: Schema.Literal("ok"),
	service: Schema.Literal("server"),
});
export type Health = typeof Health.Type;

/**
 * The NOOP-to-server connection is intentionally stubbed (friend-owned integration).
 * It carries no readings and no WHOOP-derived nudges; clients must show the source as unavailable.
 */
export const NoopConnection = Schema.Struct({
	source: Schema.Literal("noop"),
	status: Schema.Literal("not_connected"),
});
export type NoopConnection = typeof NoopConnection.Type;

/** `GET /api/sources`: every health data source and its current availability. */
export const Sources = Schema.Struct({
	sources: Schema.Array(NoopConnection),
});
export type Sources = typeof Sources.Type;

/** Every non-2xx JSON response from the server. */
export const ApiError = Schema.Struct({
	error: Schema.Literals(["not_found", "internal"]),
	message: Schema.String,
});
export type ApiError = typeof ApiError.Type;

/** A client read: either a decoded value or an explicit failure. Never an implied "all clear". */
export type Loaded<T> =
	| { readonly kind: "ready"; readonly value: T }
	| { readonly kind: "error"; readonly message: string };

/**
 * GETs a server endpoint and decodes the body with its contract. Static types cannot prove what a
 * remote service sent, so every client read goes through this decode. Never rejects.
 */
const getDecoded = async <T>(
	schema: Schema.Decoder<T>,
	url: string,
	signal: AbortSignal,
): Promise<Loaded<T>> => {
	try {
		const response = await fetch(url, { signal });
		if (!response.ok)
			return {
				kind: "error",
				message: `GET ${url} failed with HTTP ${response.status}`,
			};
		return {
			kind: "ready",
			value: await Schema.decodeUnknownPromise(schema)(await response.json()),
		};
	} catch (error) {
		return { kind: "error", message: String(error) };
	}
};

/**
 * Starts a decoded GET and reports the result unless cancelled first. Returns the cancel function,
 * so a React effect can be `useEffect(() => loadDecoded(schema, url, setState), [])`.
 */
export const loadDecoded = <T>(
	schema: Schema.Decoder<T>,
	url: string,
	onLoaded: (result: Loaded<T>) => void,
): (() => void) => {
	const controller = new AbortController();
	void getDecoded(schema, url, controller.signal).then((result) => {
		if (!controller.signal.aborted) onLoaded(result);
	});
	return () => controller.abort();
};
