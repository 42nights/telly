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

/**
 * Every non-2xx JSON response from the server. `unauthorized` (401): no valid sign-in.
 * `forbidden` (403): signed in, but not a member of the family. `invalid_request` (400): the body or
 * path failed its schema. `unavailable` (503): a provider or the database is not configured or not
 * reachable; never a substitute result. `upstream_error` (502): a provider replied with an error.
 */
export const ApiErrorCode = Schema.Literals([
	"not_found",
	"internal",
	"unauthorized",
	"forbidden",
	"invalid_request",
	"unavailable",
	"upstream_error",
]);
export type ApiErrorCode = typeof ApiErrorCode.Type;

export const ApiError = Schema.Struct({
	error: ApiErrorCode,
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

// Family records. Database ids (u64) travel as decimal strings and identities as hex strings, so
// JSON keeps them exact. Times are ISO 8601 UTC strings with microsecond precision.

export const Family = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	createdAt: Schema.String,
});
export type Family = typeof Family.Type;

/** Only `validated` samples may drive monitoring; `unvalidated` ones stay visibly unvalidated. */
export const SampleQuality = Schema.Literals(["validated", "unvalidated"]);
export type SampleQuality = typeof SampleQuality.Type;

/** One stored reading. It always carries its source time, receive time, unit, provenance, and quality. */
export const HealthSample = Schema.Struct({
	id: Schema.String,
	familyId: Schema.String,
	metric: Schema.NonEmptyString,
	value: Schema.Finite,
	unit: Schema.NonEmptyString,
	/** When the source measured the value. */
	sourceTime: Schema.String,
	/** When the database accepted the value. */
	receivedAt: Schema.String,
	/** The device or provider that produced the value. */
	source: Schema.NonEmptyString,
	/** Synthetic demo data, never a real measurement. */
	synthetic: Schema.Boolean,
	quality: SampleQuality,
});
export type HealthSample = typeof HealthSample.Type;

export const Alert = Schema.Struct({
	id: Schema.String,
	familyId: Schema.String,
	sampleId: Schema.NullOr(Schema.String),
	summary: Schema.String,
	raisedBy: Schema.String,
	createdAt: Schema.String,
});
export type Alert = typeof Alert.Type;

export const FamilyMessage = Schema.Struct({
	id: Schema.String,
	familyId: Schema.String,
	sender: Schema.String,
	body: Schema.String,
	sentAt: Schema.String,
});
export type FamilyMessage = typeof FamilyMessage.Type;

/** A family member's acknowledgement of an alert. Separate from provider delivery. */
export const AlertAcknowledgement = Schema.Struct({
	id: Schema.String,
	alertId: Schema.String,
	familyId: Schema.String,
	member: Schema.String,
	acknowledgedAt: Schema.String,
});
export type AlertAcknowledgement = typeof AlertAcknowledgement.Type;

/** Everything the caller's families hold, and nothing from any other family. */
export const FamilyRecords = Schema.Struct({
	families: Schema.Array(Family),
	samples: Schema.Array(HealthSample),
	alerts: Schema.Array(Alert),
	messages: Schema.Array(FamilyMessage),
	acknowledgements: Schema.Array(AlertAcknowledgement),
});
export type FamilyRecords = typeof FamilyRecords.Type;
