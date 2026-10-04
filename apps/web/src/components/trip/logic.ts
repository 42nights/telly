// Trip wording and maps links (issue #40). The wording never says a road is safe to cross and never
// promises to keep the wearer from getting lost; it reminds the wearer to watch the traffic.
import type { LocationFix, LocationReport } from "@health/contracts/location";

/** The trip the wearer chose. Kept on this device until the trip-purpose contract (#39) exists. */
export type Trip = {
	readonly destination: string;
	readonly purpose: string;
	/** `Date.now()` when the wearer last set or changed the trip. */
	readonly setAt: number;
};

export const TRAFFIC_NOTE =
	"Telly does not see the traffic. Stop, look, and listen before you cross.";

/** Walking directions in the phone's or browser's own maps app. Telly computes no route. */
export const directionsUrl = (destination: string) =>
	`https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${encodeURIComponent(destination)}`;

/** A point on an open map, for family members who see a shared location. */
export const mapUrl = ({ latitude, longitude }: LocationFix) =>
	`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;

/** What "Remind me" says: the chosen place and purpose, then the traffic note. */
export const tripReminder = ({ destination, purpose }: Trip) =>
	`You are going to ${destination}${purpose === "" ? "" : `, to ${purpose}`}. ${TRAFFIC_NOTE}`;

/**
 * The family message for "Help me get home". It carries no coordinates: the message reaches the
 * whole family, and only people the wearer chose may see the location.
 */
export const helpMessage = (trip: Trip | null, sharing: boolean) =>
	[
		"I need help getting home.",
		trip === null
			? null
			: `I was going to ${trip.destination}${trip.purpose === "" ? "" : ` to ${trip.purpose}`}.`,
		sharing
			? "If I share my location with you, you can see it on Telly's Family screen."
			: "I have not shared my location in Telly.",
		"Sent with Telly's Help me get home button.",
	]
		.filter((line) => line !== null)
		.join(" ");

/** The report for a browser position, rounded to what the device can know. */
export const fixReport = (position: GeolocationPosition): LocationReport => ({
	status: "fix",
	fix: {
		latitude: position.coords.latitude,
		longitude: position.coords.longitude,
		accuracyMeters: Math.max(1, Math.round(position.coords.accuracy)),
		fixTime: new Date(position.timestamp).toISOString(),
	},
});

/** Permission denied is its own state; a timeout or no signal is "no fix". */
export const errorReport = (
	error: GeolocationPositionError,
): LocationReport => ({
	status: error.code === error.PERMISSION_DENIED ? "gps_denied" : "no_fix",
});
