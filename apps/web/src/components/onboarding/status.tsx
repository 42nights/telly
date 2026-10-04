// What one family has set up, read only from real data: WHOOP samples that NOOP pushed, saved
// medication reminders, and invites made on this device (the server lists no members).
import { FamilyRecords } from "@health/contracts";
import { Reminders } from "@health/contracts/reminders";
import { useEffect, useState } from "react";

import { useNow } from "@/components/wearer/use-now";
import { type ApiState, familyPath, useApi } from "@/lib/api";

import { liveAge, newestHeartRate, whoopSamples } from "./logic";

const invitedKey = (familyId: string) => `telly.invited.${familyId}`;

export function useSetupStatus(familyId: string) {
	const [refreshKey, setRefreshKey] = useState(0);
	const records = useApi(FamilyRecords, familyPath(familyId), {
		pollMs: 30_000,
	});
	const reminders = useApi(Reminders, familyPath(familyId, "/reminders"), {
		refreshKey,
	});
	const [invited, setInvited] = useState(false);
	useEffect(
		() => setInvited(localStorage.getItem(invitedKey(familyId)) !== null),
		[familyId],
	);
	return {
		records,
		hasWhoop:
			records.kind === "ready" &&
			whoopSamples(records.value.samples).length > 0,
		hasMedicine:
			reminders.kind === "ready" &&
			reminders.value.reminders.some((r) => r.kind === "medication"),
		invited,
		markInvited: () => {
			localStorage.setItem(invitedKey(familyId), new Date().toISOString());
			setInvited(true);
		},
		refreshReminders: () => setRefreshKey((key) => key + 1),
	};
}

/** The WHOOP line: the newest real heart rate with its age, or "Waiting for WHOOP". */
export function WhoopStatus({ records }: { records: ApiState<FamilyRecords> }) {
	const now = useNow();
	if (records.kind === "loading") return <span>Checking WHOOP…</span>;
	if (records.kind === "signed_out") return <span>Sign in to see WHOOP.</span>;
	if (records.kind !== "ready")
		return <span role="alert">Could not check WHOOP: {records.message}</span>;
	const samples = whoopSamples(records.value.samples);
	if (samples.length === 0) return <b>Waiting for WHOOP</b>;
	const heart = newestHeartRate(samples);
	if (heart === null) return <span>WHOOP sends data · no heart rate yet</span>;
	const age = liveAge(heart.sourceTime, now);
	return (
		<span className="flex flex-wrap items-center gap-1.5">
			<b className={age.tone === "old" ? "text-[#404040]" : undefined}>
				{heart.value} {heart.unit}
			</b>
			<span
				className={`border border-black px-1.5 font-bold text-xs ${age.tone === "current" ? "bg-[#d6f5d6]" : "bg-[#ffffe1]"}`}
			>
				{age.text}
			</span>
			<small>
				WHOOP (via NOOP){heart.quality === "unvalidated" && " · unvalidated"}
			</small>
		</span>
	);
}
