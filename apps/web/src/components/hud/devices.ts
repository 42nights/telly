// One status pane per device or service, from what it can actually report (issue #45). An unknown
// battery is never 0 %, "not connected" is never "not worn", and a saved reading is never current.
// Each pane is one short phrase; `detail` goes in its tooltip, and `state` colours its dot.
import type { Sources } from "@health/contracts";

import { ago } from "@/components/family/logic";

/** What the browser's Battery Status API reported, or null when this browser reports no battery. */
export type Battery = {
	readonly level: number;
	readonly charging: boolean;
} | null;

export type Pane = {
	readonly text: string;
	readonly detail: string;
	readonly state: "ok" | "warn" | "bad" | "unknown";
};

/** The device in hand. `battery` is undefined while it is still being read. */
export const phoneLine = (
	online: boolean,
	battery: Battery | undefined,
): Pane => {
	const percent =
		battery === undefined || battery === null
			? null
			: `${Math.round(battery.level * 100)} %`;
	const power =
		battery === undefined
			? "Battery: checking…"
			: battery === null
				? "Battery unknown."
				: `Battery ${percent}${battery.charging ? ", charging" : ""}.`;
	return online
		? {
				text: percent === null ? "Phone online" : `Phone ${percent}`,
				detail: `Online. ${power}`,
				state: "ok",
			}
		: {
				text: "Phone offline",
				detail: `Offline: answers, directions, and messages wait. ${power}`,
				state: "bad",
			};
};

/**
 * The WHOOP strap, from the server's NOOP source: connected while a push arrived in the last
 * 10 minutes. It never reports wear or an all-clear. `sources` is null while unknown.
 */
export const wearableLine = (sources: Sources | null, now: number): Pane => {
	if (sources === null)
		return { text: "WHOOP", detail: "Status unknown.", state: "unknown" };
	const noop = sources.sources.find((source) => source.source === "noop");
	if (noop === undefined)
		return {
			text: "WHOOP not set up",
			detail: "No source configured.",
			state: "bad",
		};
	if (noop.lastSeenAt === null)
		return { text: "WHOOP off", detail: "No reading yet.", state: "bad" };
	const last = `Last reading ${ago(noop.lastSeenAt, now)}.`;
	if (noop.status === "connected")
		return {
			text: "WHOOP online",
			detail: `Connected. ${last}`,
			state: "ok",
		};
	return {
		text: `WHOOP ${ago(noop.lastSeenAt, now)}`,
		detail: `Not connected: no new readings, wear unknown. ${last}`,
		state: "warn",
	};
};
