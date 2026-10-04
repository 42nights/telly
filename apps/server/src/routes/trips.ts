// Leaving-home check-in routes, relative to `/api/families/:familyId`. The module's reducer checks
// membership, the step order, and the debounce again, and writes the chosen family messages.
import {
	type CurrentTrip,
	StartTrip,
	TRIP_QUESTION,
	type Trip,
	TripAnswer,
	type TripCheckIn,
	type TripReply,
} from "@health/contracts/trips";
import type { Context } from "hono";
import { Hono } from "hono";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";

const steps = {
	Asked: "asked",
	Leaving: "leaving",
	Cancelled: "cancelled",
	Arrived: "arrived",
} as const;

/** The family's trips, oldest first. The last one holds the family's latest step. */
const readTrips = (c: Context<FamilyEnv>): Trip[] => {
	const rows = [...c.var.db.connection.db.myTripEvents.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	const byTrip = new Map<string, typeof rows>();
	for (const row of rows)
		byTrip.set(row.tripId, [...(byTrip.get(row.tripId) ?? []), row]);
	return [...byTrip.values()]
		.sort((a, b) => ((a.at(-1)?.id ?? 0n) < (b.at(-1)?.id ?? 0n) ? -1 : 1))
		.flatMap((trip) => {
			const [first, last] = [trip[0], trip.at(-1)];
			if (first === undefined || last === undefined) return [];
			const events = trip.map((row) => ({
				step: steps[row.step.tag],
				source:
					row.source === "departure_signal"
						? ("departure_signal" as const)
						: ("manual" as const),
				purpose: row.purpose ?? null,
				destination: row.destination ?? null,
				by: row.by.toHexString(),
				at: row.at.toISOString(),
			}));
			const plan = trip.findLast((row) => row.step.tag === "Leaving");
			return [
				{
					id: first.tripId,
					status: steps[last.step.tag],
					source: events[0]?.source ?? "manual",
					plan:
						plan?.purpose === undefined
							? null
							: {
									purpose: plan.purpose,
									destination: plan.destination ?? null,
									statedAt: plan.at.toISOString(),
									statedBy: plan.by.toHexString(),
								},
					notify: {
						departure: plan?.notifyDeparture ?? false,
						arrival: plan?.notifyArrival ?? false,
					},
					events,
				},
			];
		});
};

const APPOINTMENT =
	/\b(doctor|appointment|clinic|hospital|dentist|check-?up|therapy|surgery)\b/i;
const LOW_BATTERY = 0.3;

/**
 * The items to check before leaving, from the stated purpose and the device battery. Items from
 * the care profile (such as a mobility aid) need the saved profile of issue #26.
 */
export const essentials = (purpose: string, battery: number | null) => [
	"keys",
	"phone",
	...(APPOINTMENT.test(purpose) ? ["appointment letter", "medicine list"] : []),
	...(battery !== null && battery < LOW_BATTERY
		? [`phone charger (battery at ${Math.round(battery * 100)}%)`]
		: []),
];

export const tripRoutes = () =>
	new Hono<FamilyEnv>()
		.get("/trips/current", (c) =>
			c.json({ trip: readTrips(c).at(-1) ?? null } satisfies CurrentTrip),
		)
		.post("/trips/check-in", async (c) => {
			const { source } = await decodeBody(c, StartTrip);
			const tripId = crypto.randomUUID();
			await callReducer(c.var.db, (connection) =>
				connection.reducers.recordTripEvent({
					familyId: c.var.familyId,
					tripId,
					step: { tag: "Asked" },
					source,
					plan: undefined,
				}),
			);
			const trip = readTrips(c).at(-1);
			if (trip === undefined)
				throw new Error("the check-in is not visible to its sender");
			return c.json({
				asked: trip.id === tripId,
				question: TRIP_QUESTION,
				trip,
			} satisfies TripCheckIn);
		})
		.post("/trips/:tripId/answer", async (c) => {
			const answer = await decodeBody(c, TripAnswer);
			const tripId = c.req.param("tripId");
			if (!readTrips(c).some((trip) => trip.id === tripId))
				throw new ApiFailure("not_found", "No such trip");
			const leaving = answer.answer === "leaving" ? answer : null;
			await callReducer(c.var.db, (connection) =>
				connection.reducers.recordTripEvent({
					familyId: c.var.familyId,
					tripId,
					step: {
						tag:
							answer.answer === "leaving"
								? "Leaving"
								: answer.answer === "cancel"
									? "Cancelled"
									: "Arrived",
					},
					source: "manual",
					plan:
						leaving === null
							? undefined
							: {
									purpose: leaving.purpose,
									destination: leaving.destination ?? undefined,
									notifyDeparture: leaving.notify.departure,
									notifyArrival: leaving.notify.arrival,
								},
				}),
			);
			const trip = readTrips(c).find((stored) => stored.id === tripId);
			if (trip === undefined)
				throw new Error("the trip is not visible to its sender");
			const items =
				leaving === null ? [] : essentials(leaving.purpose, leaving.battery);
			return c.json({
				trip,
				essentials: items,
				prompt:
					leaving === null
						? null
						: `Before you go, check: ${items.join(", ")}.`,
			} satisfies TripReply);
		});
