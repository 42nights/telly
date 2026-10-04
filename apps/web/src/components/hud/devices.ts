// One status line per device, from what that device can actually report (issue #45). An unknown
// battery is never 0 %, "not connected" is never "not worn", and a saved reading is never current.
import type { HealthSample, Sources } from "@health/contracts";

import { ago } from "@/components/family/logic";

/** What the browser's Battery Status API reported, or null when this browser reports no battery. */
export type Battery = {
	readonly level: number;
	readonly charging: boolean;
} | null;

/** The device the wearer holds. `battery` is undefined while it is still being read. */
export const phoneLine = (
	online: boolean,
	battery: Battery | undefined,
): string => {
	const power =
		battery === undefined
			? "battery: checking…"
			: battery === null
				? "battery unknown"
				: `battery ${Math.round(battery.level * 100)} %${battery.charging ? " · charging" : ""}`;
	return online
		? `This phone · online · ${power}`
		: `This phone · offline · answers, directions, and messages wait · ${power}`;
};

/**
 * The WHOOP strap. Its readings arrive only through NOOP (samples from `noop:<device>`), and the
 * `Sources` contract has no connected state, so this line never reports new readings, wear, or an
 * all-clear. `sources` is null while unknown. The last reading shows only when a real one is stored.
 */
export const wearableLine = (
	sources: Sources | null,
	samples: readonly HealthSample[] | null,
	now: number,
): string => {
	const noop = sources?.sources.find((source) => source.source === "noop");
	const live = noop?.status === "connected";
	const link =
		sources === null
			? "status unknown"
			: noop === undefined
				? "no source configured"
				: live
					? "connected · unvalidated"
					: "not connected · no new readings · wear unknown";
	let newest: HealthSample | null = null;
	for (const sample of samples ?? [])
		if (
			!sample.synthetic &&
			sample.source.startsWith("noop:") &&
			(newest === null || sample.sourceTime > newest.sourceTime)
		)
			newest = sample;
	const contact =
		newest === null
			? "last contact unknown"
			: `last reading ${ago(newest.sourceTime, now)}${live ? "" : " · saved, not current"}`;
	return `WHOOP · ${link} · ${contact}`;
};
