// The family screen's reads for the selected family, and the "Mark as seen" write.
import { type Family, FamilyRecords } from "@health/contracts";
import {
	AcknowledgedAlert,
	AlertThresholds,
	type FamilyAlert,
	FamilyAlerts,
	Monitoring,
} from "@health/contracts/alerts";
import { type FamilyList, Me } from "@health/contracts/families";
import { useEffect, useState } from "react";

import { type ApiState, apiRequest, familyPath, useApi } from "@/lib/api";
import { useDemoWarning } from "@/lib/demo";
import { useFamily } from "@/lib/family";

import { newestUnseen } from "./logic";

const POLL_MS = 15_000;
/** Records carry the live WHOOP heart rate, which the phone pushes every 15-30 s (#208). */
// ponytail: every poll re-reads all family samples; read only the newest if the payload grows slow.
export const RECORDS_POLL_MS = 5_000;

/** The selected family and everything the family screen reads about it. */
export type FamilyData = {
	readonly familyState: ApiState<FamilyList>;
	readonly family: Family | null;
	readonly alerts: ApiState<FamilyAlerts>;
	readonly monitoring: ApiState<Monitoring>;
	readonly thresholds: ApiState<AlertThresholds>;
	readonly records: ApiState<FamilyRecords>;
	/** `records` for its readings: `forbidden` when health records are not shared with the caller. */
	readonly readings: ApiState<FamilyRecords>;
	/** The caller's identity, or null until `/api/me` answers. */
	readonly me: string | null;
	readonly markSeen: (alertId: string) => Promise<void>;
	/** The alert whose "Mark as seen" request is in flight. */
	readonly busyId: string | null;
	readonly seenError: string | null;
};

/** The reads of `useFamilyData`, which the Family route loaders start ahead of the screen. */
export const familyReads = (familyId: string) =>
	[
		[FamilyAlerts, familyPath(familyId, "/alerts")],
		[Monitoring, familyPath(familyId, "/monitoring")],
		[AlertThresholds, familyPath(familyId, "/alert-thresholds")],
		[FamilyRecords, familyPath(familyId)],
		[Me, "/api/me"],
	] as const;

export function useFamilyData(): FamilyData {
	const { state: familyState, family } = useFamily();
	const [seenError, setSeenError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const path = (suffix: string) =>
		family === null ? null : familyPath(family.id, suffix);
	const options = { pollMs: POLL_MS };
	const alerts = useApi(FamilyAlerts, path("/alerts"), options);
	const monitoring = useApi(Monitoring, path("/monitoring"), options);
	const thresholds = useApi(
		AlertThresholds,
		path("/alert-thresholds"),
		options,
	);
	const records = useApi(FamilyRecords, path(""), { pollMs: RECORDS_POLL_MS });
	const me = useApi(Me, "/api/me");
	useDemoWarning(
		records.kind === "ready" ? records.value.samples : null,
		"Demo samples are not shown. The family records contain",
	);
	// A "Mark as seen" failure belongs to the person it was for.
	const familyId = family?.id;
	useEffect(() => {
		void familyId;
		setSeenError(null);
	}, [familyId]);

	const markSeen = async (alertId: string) => {
		const alertsPath = path(
			`/alerts/${encodeURIComponent(alertId)}/acknowledgements`,
		);
		if (alertsPath === null) return;
		setBusyId(alertId);
		setSeenError(null);
		const result = await apiRequest(AcknowledgedAlert, alertsPath, {
			method: "POST",
		});
		setBusyId(null);
		if (result.kind !== "ready")
			setSeenError(
				result.kind === "signed_out"
					? "Sign in to mark this alert as seen."
					: `Could not mark as seen: ${result.message}`,
			);
	};

	return {
		familyState,
		family,
		alerts,
		monitoring,
		thresholds,
		records,
		// Records keep family chat for every member; their samples need `health_records` (#26),
		// which `/monitoring` checks.
		readings: monitoring.kind === "forbidden" ? monitoring : records,
		me: me.kind === "ready" ? me.value.identity : null,
		markSeen,
		busyId,
		seenError,
	};
}

/**
 * The alert to act on: the newest unseen one. Once shown, it stays shown in its seen state after
 * someone marks it, so the card does not jump away; a newer unseen alert replaces it.
 */
export function useShownAlert(
	alerts: readonly FamilyAlert[],
): FamilyAlert | null {
	const unseen = newestUnseen(alerts);
	const [shownId, setShownId] = useState<string | null>(null);
	useEffect(() => {
		if (unseen !== null) setShownId(unseen.alert.id);
	}, [unseen]);
	return alerts.find((a) => a.alert.id === shownId) ?? unseen;
}
