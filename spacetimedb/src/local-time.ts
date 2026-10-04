// Wall-clock math in one IANA time zone for the reminder scheduler (issue #28). Instants are epoch
// milliseconds; a local time is minutes after local midnight. The module runtime's `Intl` carries the
// time zone rules, so daylight-saving changes follow the zone, not a fixed offset.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const localAt = (ms: number, timeZone: string) => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
	}).formatToParts(new Date(ms));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((p) => p.type === type)?.value);
	return {
		date: Date.UTC(part("year"), part("month") - 1, part("day")),
		minute: part("hour") * 60 + part("minute"),
	};
};

/** Local wall time minus UTC at `ms`, in milliseconds. */
const offsetAt = (ms: number, timeZone: string) => {
	const local = localAt(ms, timeZone);
	return local.date + local.minute * MINUTE_MS - (ms - (ms % MINUTE_MS));
};

/**
 * The instant of local `minute` on the local day that starts at UTC midnight `date`. A time that a
 * clock change skips moves forward by the gap (02:30 becomes 03:30); a time that it repeats takes the
 * first of its two instants.
 */
const instantOf = (date: number, minute: number, timeZone: string) => {
	const wall = date + minute * MINUTE_MS;
	const before = wall - offsetAt(wall - DAY_MS, timeZone);
	const after = wall - offsetAt(wall + DAY_MS, timeZone);
	const valid = [before, after].filter(
		(at) => offsetAt(at, timeZone) === wall - at,
	);
	return valid.length === 0 ? before : Math.min(...valid);
};

/** The first instant strictly after `afterMs` at which the local clock shows `minute`. */
export const nextLocalTime = (
	afterMs: number,
	minute: number,
	timeZone: string,
) => {
	const { date } = localAt(afterMs, timeZone);
	for (const day of [0, 1, 2]) {
		const at = instantOf(date + day * DAY_MS, minute, timeZone);
		if (at > afterMs) return at;
	}
	throw new Error("no next local time within two days");
};

/** Local minutes after midnight, `start` inclusive and `end` exclusive; `start > end` spans midnight. */
export type QuietHours = { readonly start: number; readonly end: number };

/** `ms`, or the end of quiet hours when `ms` falls inside them. */
export const afterQuietHours = (
	ms: number,
	quiet: QuietHours | undefined,
	timeZone: string,
) => {
	if (quiet === undefined || quiet.start === quiet.end) return ms;
	const { minute } = localAt(ms, timeZone);
	const inside =
		quiet.start < quiet.end
			? minute >= quiet.start && minute < quiet.end
			: minute >= quiet.start || minute < quiet.end;
	return inside ? nextLocalTime(ms, quiet.end, timeZone) : ms;
};
