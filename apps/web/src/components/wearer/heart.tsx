import type { FamilyRecords } from "@health/contracts";
import { Heart } from "lucide-react";

import type { ApiState } from "@/lib/api";

import { ago, barPercent, currentHeartRate, USUAL_BPM } from "./logic";

const failureLine = {
	loading: "waiting for the server",
	signed_out: "sign in to see readings",
	forbidden: "not shared with you",
	unavailable: "can't read right now",
	error: "can't read right now",
} as const;

/**
 * The newest fresh, validated heart-rate reading with its source and age, and a range bar that
 * marks the usual band only. Anything else shows "Unavailable", never an old number.
 */
export function HeartReading({
	records,
	familyId,
	now,
}: {
	/** Null when the caller has no person paired yet. */
	records: ApiState<FamilyRecords> | null;
	familyId: string | null;
	now: number;
}) {
	const sample =
		records?.kind === "ready" && familyId !== null
			? currentHeartRate(records.value.samples, familyId, now)
			: null;
	const usual = {
		left: barPercent(USUAL_BPM.low),
		right: barPercent(USUAL_BPM.high),
	};
	return (
		<div className="grid justify-items-end gap-1 text-right text-[16px]">
			<span className="flex items-center gap-1.5 font-bold text-[18px]">
				<Heart aria-hidden className="size-5" />
				Heart rate
			</span>
			{sample === null ? (
				<>
					<b className="text-[22px]">
						{records?.kind === "loading" ? "Checking…" : "Unavailable"}
					</b>
					<div
						aria-label="No reading"
						className="win95-inset h-[18px] w-38 bg-[repeating-linear-gradient(45deg,var(--win95-face)_0_4px,#fff_4px_8px)]"
						role="img"
					/>
					<span className="text-muted-foreground">
						{records === null
							? "no person paired"
							: records.kind === "ready"
								? "no recent reading"
								: failureLine[records.kind]}
					</span>
				</>
			) : (
				<>
					<b className="text-[26px] leading-tight">
						{Math.round(sample.value)}{" "}
						<small className="font-normal text-[16px]">bpm</small>
					</b>
					<div
						aria-label={`${Math.round(sample.value)} beats per minute. The band shows the usual range, ${USUAL_BPM.low} to ${USUAL_BPM.high}.`}
						className="win95-inset relative h-[18px] w-38 bg-white"
						role="img"
					>
						<span
							className="absolute inset-y-1 bg-[repeating-linear-gradient(90deg,#b8c0f0_0_3px,#fff_3px_5px)]"
							style={{
								left: `${usual.left}%`,
								width: `${usual.right - usual.left}%`,
							}}
						/>
						<i
							className="absolute inset-y-[3px] w-[5px] -translate-x-1/2 bg-[#000080]"
							style={{ left: `${barPercent(sample.value)}%` }}
						/>
					</div>
					<span className="text-muted-foreground">
						{ago(now - Date.parse(sample.sourceTime))} · {sample.source}
					</span>
				</>
			)}
		</div>
	);
}
