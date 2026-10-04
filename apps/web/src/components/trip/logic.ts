// Going out wording and maps links (issues #40 and #302). The wording never says a road is safe to
// cross and never promises to keep the wearer from getting lost.
import type {
	AwayEvent,
	HomePoint,
	HomeWatch,
	LocationReport,
} from "@health/contracts/location";

/** The typed home address on this device: the optional fallback for Directions home. */
export const HOME_ADDRESS_KEY = "telly.home";

/** Walking directions to a typed address or a saved position, in the phone's own maps app. */
export const directionsUrl = (destination: string | HomePoint) =>
	`https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${encodeURIComponent(
		typeof destination === "string"
			? destination
			: `${destination.latitude},${destination.longitude}`,
	)}`;

/** A point on an open map, for family members who see a shared location. */
export const mapUrl = ({ latitude, longitude }: HomePoint) =>
	`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;

const timeOf = (iso: string) =>
	new Date(iso).toLocaleTimeString([], { timeStyle: "short" });

/**
 * The wearer's status during a trip, under the "You are out" heading: "1.2 km from home · left 10
 * min ago". Without a known distance from home (`meters`), the distance is left out, never guessed.
 */
const outStatus = (awaySince: string, meters: number | null, now: number) => {
	const minutes = Math.max(
		0,
		Math.round((now - Date.parse(awaySince)) / 60_000),
	);
	return [
		meters === null
			? null
			: meters < 1000
				? `${Math.round(meters / 10) * 10} m from home`
				: `${(meters / 1000).toFixed(1)} km from home`,
		minutes < 1
			? "left just now"
			: minutes < 120
				? `left ${minutes} min ago`
				: `left at ${timeOf(awaySince)}`,
	]
		.filter((part) => part !== null)
		.join(" · ");
};

/** The wearer's status line on Going out at `now` (ms): out, at home, or what is still missing. */
export const tripStatus = (watch: HomeWatch, now: number) => {
	if (watch.awaySince !== null)
		return outStatus(watch.awaySince, watch.distanceMeters, now);
	if (watch.home === null)
		return "Telly can notice when you go out, so you do not have to tell it.";
	if (!watch.autoTrip)
		return "Telly does not watch for trips. You can turn it on in Settings.";
	return watch.sharing
		? "You are at home. Telly tells the people you chose when you go out."
		: "Share your location with someone below. Then Telly tells them when you go out and come back.";
};

/**
 * The family message for "Help me get home". It carries no coordinates: the message reaches the
 * whole family, and only people the wearer chose may see the location.
 */
export const helpMessage = (awaySince: string | null, sharing: boolean) =>
	[
		"I need help getting home.",
		awaySince === null ? null : `I left home at ${timeOf(awaySince)}.`,
		sharing
			? "If I share my location with you, you can see it on Telly's Family screen."
			: "I have not shared my location in Telly.",
		"Sent with Telly's Help me get home button.",
	]
		.filter((line) => line !== null)
		.join(" ");

/** A trip start or end as the family reads it, such as "Mom left home at 10:02 AM". */
export const awayText = (name: string, event: AwayEvent) =>
	event.kind === "left"
		? `${name} left home at ${timeOf(event.at)}${event.manual ? " (pressed “I'm going out”)" : ""}.`
		: `${name} is back home at ${timeOf(event.at)}.`;

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
