// Family location under `/api/families/:familyId/location`. A person shares their location with
// chosen family members, one by one, and may revoke each share. Only the latest report is stored.
import { Schema } from "effect";
import { DbId, IdentityHex, UtcTime } from "./families";

export const LocationFix = Schema.Struct({
	latitude: Schema.Finite.check(
		Schema.isBetween({ minimum: -90, maximum: 90 }),
	),
	longitude: Schema.Finite.check(
		Schema.isBetween({ minimum: -180, maximum: 180 }),
	),
	/** The device's own accuracy radius, in meters. */
	accuracyMeters: Schema.Finite.check(Schema.isGreaterThan(0)),
	/** When the device took the fix, by the device clock. */
	fixTime: UtcTime,
});
export type LocationFix = typeof LocationFix.Type;

/** `no_fix`: the device allowed location but got no position (timeout or no signal). */
export const LocationStatus = Schema.Literals(["fix", "gps_denied", "no_fix"]);
export type LocationStatus = typeof LocationStatus.Type;

/** `POST /location`: the sender's device reports a fix or why it has none. */
export const LocationReport = Schema.Union([
	Schema.Struct({ status: Schema.Literal("fix"), fix: LocationFix }),
	Schema.Struct({ status: Schema.Literals(["gps_denied", "no_fix"]) }),
]);
export type LocationReport = typeof LocationReport.Type;

/**
 * A person's latest report. `fix` is the last good fix, kept when a later report has none, or
 * `null` when there was never one. `reportedAt` is when the server accepted the latest report.
 */
export const SharedLocation = Schema.Struct({
	familyId: DbId,
	sharer: IdentityHex,
	status: LocationStatus,
	fix: Schema.NullOr(LocationFix),
	reportedAt: UtcTime,
});
export type SharedLocation = typeof SharedLocation.Type;

/** `sharer` lets `viewer` see their location. */
export const LocationShare = Schema.Struct({
	familyId: DbId,
	sharer: IdentityHex,
	viewer: IdentityHex,
	sharedAt: UtcTime,
});
export type LocationShare = typeof LocationShare.Type;

/**
 * `GET /location`: the caller's own location and those shared with the caller, and the caller's
 * shares. Another person's location needs both their share and the caller's `location` care scope
 * (#26); `seesShared` is false when the caller lacks that scope, so `locations` holds only their own.
 */
export const FamilyLocations = Schema.Struct({
	locations: Schema.Array(SharedLocation),
	shares: Schema.Array(LocationShare),
	seesShared: Schema.Boolean,
});
export type FamilyLocations = typeof FamilyLocations.Type;

/** A fix older than this is no longer current. */
export const STALE_FIX_MS = 10 * 60_000;
/** No report for this long: the phone may be off, out of signal, or not carried. */
export const SILENT_PHONE_MS = 30 * 60_000;
/** A wider accuracy radius is only approximate; indoors, GPS often reports this. */
export const APPROXIMATE_METERS = 100;

export type LocationLabel = {
	readonly kind:
		| "current"
		| "approximate"
		| "last_known"
		| "gps_denied"
		| "no_signal"
		| "phone_silent"
		| "no_position";
	/** One plain sentence for screen and speech. Never says the person is safe. */
	readonly text: string;
	/** The fix to show with its own time and accuracy, or null when there is none. */
	readonly fix: LocationFix | null;
};

const minutes = (ms: number) => {
	const m = Math.max(0, Math.round(ms / 60_000));
	return m < 1
		? "under a minute"
		: m < 120
			? `${m} min`
			: `${Math.round(m / 60)} h`;
};

/**
 * Labels one shared location at `now` (ms): current, approximate, or last known, and why a fresh
 * fix is missing. The phone's silence comes first: an old report says nothing about now.
 */
export const describeLocation = (
	location: SharedLocation,
	now: number,
): LocationLabel => {
	const { fix } = location;
	const silentFor = now - Date.parse(location.reportedAt);
	if (silentFor > SILENT_PHONE_MS)
		return {
			kind: "phone_silent",
			text: `No update from the phone for ${minutes(silentFor)}. It may be off, out of signal, or not carried.`,
			fix,
		};
	if (location.status === "gps_denied")
		return {
			kind: "gps_denied",
			text:
				fix === null
					? "Location is turned off on the phone. There is no position."
					: "Location is turned off on the phone. Showing the last known position.",
			fix,
		};
	if (fix === null)
		return {
			kind: "no_position",
			text: "The phone has not found a position yet.",
			fix,
		};
	if (location.status === "no_fix")
		return {
			kind: "no_signal",
			text: "The phone has no GPS signal now, possibly indoors. Showing the last known position.",
			fix,
		};
	const age = now - Date.parse(fix.fixTime);
	if (age > STALE_FIX_MS)
		return {
			kind: "last_known",
			text: `Last known position, ${minutes(age)} old.`,
			fix,
		};
	if (fix.accuracyMeters > APPROXIMATE_METERS)
		return {
			kind: "approximate",
			text: `Approximate position, within ${Math.round(fix.accuracyMeters)} m. Indoors, GPS is often less exact.`,
			fix,
		};
	return {
		kind: "current",
		text: `Current position, within ${Math.round(fix.accuracyMeters)} m.`,
		fix,
	};
};
