// One status chip per device, from what that device can actually report (issue #45). An unknown
// battery is never 0 %, "not connected" is never "not worn", and a saved reading is never current.
// Each chip is one short phrase; `detail` goes in its tooltip.
import type { HealthSample, Sources } from "@health/contracts";

import { ago, oldAge } from "@/components/family/logic";

/** What the browser's Battery Status API reported, or null when this browser reports no battery. */
export type Battery = {
	readonly level: number;
	readonly charging: boolean;
} | null;

export type Chip = { readonly text: string; readonly detail: string };

/** The device the wearer holds. `battery` is undefined while it is still being read. */
export const phoneLine = (
	online: boolean,
	battery: Battery | undefined,
): Chip => {
	const power =
		battery === undefined
			? "Battery: checking…"
			: battery === null
				? "Battery unknown"
				: `Battery ${Math.round(battery.level * 100)} %${battery.charging ? ", charging" : ""}`;
	return online
		? { text: "Phone online", detail: power }
		: {
				text: "Phone offline",
				detail: `Answers, directions, and messages wait. ${power}`,
			};
};

/**
 * The WHOOP strap. Its readings arrive only through NOOP (samples from `noop:<device>`), and the
 * `Sources` contract has no connected state, so this chip never reports wear or an all-clear.
 * `sources` is null while unknown. The last reading shows only when a real one is stored.
 */
export const wearableLine = (
	sources: Sources | null,
	samples: readonly HealthSample[] | null,
	now: number,
): Chip => {
	let newest: HealthSample | null = null;
	for (const sample of samples ?? [])
		if (
			!sample.synthetic &&
			sample.source.startsWith("noop:") &&
			(newest === null || sample.sourceTime > newest.sourceTime)
		)
			newest = sample;
	const last =
		newest === null
			? "No reading yet."
			: `Last reading ${ago(newest.sourceTime, now)}.`;
	if (sources === null) return { text: "WHOOP", detail: "Status unknown." };
	const noop = sources.sources.find((source) => source.source === "noop");
	if (noop === undefined)
		return { text: "WHOOP not set up", detail: "No source configured." };
	if (noop.status !== "connected")
		return {
			text: "WHOOP not connected",
			detail:
				`No new readings; wear unknown. ${newest === null ? "" : `${last} Saved, not current.`}`.trim(),
		};
	const age = newest === null ? null : oldAge(newest.sourceTime, now);
	return {
		text: age === null ? "WHOOP connected" : `WHOOP · ${age}`,
		detail: last,
	};
};
