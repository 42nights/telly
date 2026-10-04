// Background location for automatic trips (#302). The web app turns it on and off through the
// bridge (`location-watch`). The phone then sends its position to the server while the app is in
// the background, and the database decides when a trip starts and ends. Before each send the task
// reads the person's own settings, so turning automatic trips off on any device, or stopping the
// last share, stops it here too.
import { HomeWatch } from "@health/contracts/location";
import { Schema } from "effect";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";

import { ENV } from "@/src/env";

import { readSession } from "./session";

const TASK = "telly-location-watch";
const FAMILY_KEY = "telly.locationWatch.family";
const decodeWatch = Schema.decodeUnknownOption(HomeWatch);

const stop = async () => {
	await SecureStore.deleteItemAsync(FAMILY_KEY);
	if (await Location.hasStartedLocationUpdatesAsync(TASK))
		await Location.stopLocationUpdatesAsync(TASK);
};

/**
 * Starts background location for `familyId`, or stops it (`null`). Without the "Always" permission
 * nothing starts: the web app still sends the position while it is open.
 */
export const setLocationWatch = async (familyId: string | null) => {
	if (familyId === null) return stop();
	if (!(await Location.requestForegroundPermissionsAsync()).granted) return;
	if (!(await Location.requestBackgroundPermissionsAsync()).granted) return;
	await SecureStore.setItemAsync(FAMILY_KEY, familyId);
	if (await Location.hasStartedLocationUpdatesAsync(TASK)) return;
	await Location.startLocationUpdatesAsync(TASK, {
		accuracy: Location.Accuracy.Balanced,
		distanceInterval: 50,
		deferredUpdatesInterval: 60_000,
		pausesUpdatesAutomatically: false,
		showsBackgroundLocationIndicator: true,
		activityType: Location.ActivityType.Other,
	});
};

// iOS wakes the app with new positions; only the newest is sent, as the web app does.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(
	TASK,
	async ({ data, error }) => {
		const latest = data.locations.at(-1);
		const familyId = await SecureStore.getItemAsync(FAMILY_KEY);
		// A position without an accuracy cannot be judged, so it is not sent.
		const accuracy = latest?.coords.accuracy ?? null;
		if (error !== null || latest === undefined || accuracy === null) return;
		if (familyId === null) return;
		const session = await readSession();
		if (session === null) return stop();
		const family = `${ENV.EXPO_PUBLIC_SERVER_URL}/api/families/${encodeURIComponent(familyId)}`;
		const headers = {
			Authorization: `Bearer ${session.idToken}`,
			"Content-Type": "application/json",
		};
		const reply = await fetch(`${family}/location/home`, { headers });
		if (!reply.ok) return;
		const watch = decodeWatch(await reply.json());
		if (watch._tag === "None") return;
		const { sharing, autoTrip, awaySince } = watch.value;
		if (!sharing || !(autoTrip || awaySince !== null)) return stop();
		await fetch(`${family}/location`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				status: "fix",
				fix: {
					latitude: latest.coords.latitude,
					longitude: latest.coords.longitude,
					accuracyMeters: Math.max(1, Math.round(accuracy)),
					fixTime: new Date(latest.timestamp).toISOString(),
				},
			}),
		});
	},
);
