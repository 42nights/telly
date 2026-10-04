import {
	type LocationReport,
	SharedLocation,
} from "@health/contracts/location";
import { useEffect, useRef, useState } from "react";

import { apiRequest, familyPath } from "@/lib/api";

import { errorReport, fixReport } from "./logic";

export type Reporting =
	| { readonly kind: "off" }
	| { readonly kind: "waiting" }
	| { readonly kind: "sent"; readonly report: SharedLocation }
	| { readonly kind: "failed"; readonly message: string };

/** A position is sent at most this often; a change of status is sent at once. */
const MIN_GAP_MS = 60_000;

/**
 * While `active`, watches this device's position and sends it to the family. The server refuses
 * a report unless the wearer shares with someone, so pass `active` only while a share exists.
 */
export function useLocationReporter(
	familyId: string | null,
	active: boolean,
): Reporting {
	const [state, setState] = useState<Reporting>({ kind: "off" });
	const last = useRef<{ status: string; at: number } | null>(null);
	useEffect(() => {
		if (!active || familyId === null) {
			setState({ kind: "off" });
			return;
		}
		setState({ kind: "waiting" });
		last.current = null;
		const controller = new AbortController();
		const send = async (report: LocationReport) => {
			const now = Date.now();
			const previous = last.current;
			if (
				previous !== null &&
				previous.status === report.status &&
				now - previous.at < MIN_GAP_MS
			)
				return;
			last.current = { status: report.status, at: now };
			const result = await apiRequest(
				SharedLocation,
				familyPath(familyId, "/location"),
				{ method: "POST", body: report, signal: controller.signal },
			).catch(() => null);
			if (result === null || controller.signal.aborted) return;
			if (result.kind === "ready") {
				setState({ kind: "sent", report: result.value });
				return;
			}
			// Unsent: let the next position try again at once.
			last.current = null;
			setState({
				kind: "failed",
				message:
					result.kind === "signed_out"
						? "Not sent: sign in again."
						: `Not sent: ${result.message}`,
			});
		};
		if (!("geolocation" in navigator)) {
			void send({ status: "no_fix" });
			return () => controller.abort();
		}
		const watch = navigator.geolocation.watchPosition(
			(position) => void send(fixReport(position)),
			(error) => void send(errorReport(error)),
			{ enableHighAccuracy: true, maximumAge: 30_000, timeout: 60_000 },
		);
		return () => {
			controller.abort();
			navigator.geolocation.clearWatch(watch);
		};
	}, [familyId, active]);
	return state;
}
