import {
	type CheckInEvent,
	EmergencyOutcome,
	type Handoff,
	type LocationReading,
} from "@health/contracts/emergency";
import { Button } from "@health/ui/components/button";
import { Loader2, Phone, Siren, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Hint } from "@/components/win95";
import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";

import { xl } from "./answer";
import type { EmergencyIntent } from "./logic";

/** The emergency flow on the wearer's home: its step and the wearer's actions. */
export type EmergencyFlow = {
	readonly step: Step;
	readonly help: (report: string | null) => Promise<void>;
	readonly reply: (
		event: CheckInEvent,
		deadline: number,
		text: string | null,
	) => Promise<void>;
	/** Starts the flow for a request that `emergencyIntent` matched. */
	readonly start: (intent: EmergencyIntent, report: string) => void;
	readonly family: () => void;
};

// ponytail: fixed 30 s check-in window; make it a family setting if families ask for another.
const CHECK_IN_MS = 30_000;
/** No name or callback is stored for the wearer yet, so the handoff says "not on file". */
const WEARER = { name: null, callback: null } as const;

type Step =
	| { readonly kind: "idle" }
	| { readonly kind: "calling"; readonly what: "help" | "family" | "check_in" }
	| {
			readonly kind: "checking";
			readonly prompt: string;
			readonly event: CheckInEvent;
			readonly deadline: number;
	  }
	| { readonly kind: "done"; readonly outcome: EmergencyOutcome }
	| { readonly kind: "failed"; readonly failure: ApiFailure };

/** The browser's location, at most 3 s away. A refusal is `denied`, never a guess. */
const locate = () =>
	new Promise<LocationReading>((resolve) => {
		if (!("geolocation" in navigator))
			return resolve({ status: "unavailable" });
		navigator.geolocation.getCurrentPosition(
			({ coords, timestamp }) =>
				resolve({
					status: "fix",
					latitude: coords.latitude,
					longitude: coords.longitude,
					accuracyMeters: coords.accuracy,
					capturedAt: new Date(timestamp).toISOString(),
				}),
			(error) =>
				resolve({
					status:
						error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
				}),
			{ maximumAge: 10 * 60_000, timeout: 3_000 },
		);
	});

const where = (location: Handoff["location"]) => {
	if (!("ageSeconds" in location))
		return location.status === "denied"
			? "Not shared: location permission is off"
			: "Unavailable";
	const age =
		location.ageSeconds < 60
			? `${location.ageSeconds} s old`
			: `${Math.round(location.ageSeconds / 60)} min old`;
	return `${location.status === "current" ? "Current" : "Last known"}: ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)} · ±${Math.round(location.accuracyMeters)} m · ${age}`;
};

/** A saved list: null is unknown, empty is none recorded. Never shown as "none" when unknown. */
const listed = (items: readonly string[] | null) =>
	items === null
		? "Unknown"
		: items.length === 0
			? "None recorded"
			: items.join(", ");

function HandoffList({ handoff }: { handoff: Handoff }) {
	const { care } = handoff;
	const careRows: [string, string][] =
		care.status === "available"
			? [
					["Conditions", listed(care.conditions)],
					["Allergies", listed(care.allergies)],
					["Verified medicines", listed(care.medications)],
				]
			: [["Conditions, medicines, allergies", care.reason]];
	const rows: [string, string][] = [
		["Name", handoff.name ?? "Not on file"],
		["Callback", handoff.callback ?? "Not on file"],
		["What happened", handoff.event],
		["Exact words", handoff.report ?? "None"],
		[
			"Responding",
			handoff.responsiveness === "responding" ? "Yes" : "No answer",
		],
		...careRows,
		["Location", where(handoff.location)],
	];
	return (
		<dl className="win95-inset grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 bg-card p-2 text-[15px]">
			{rows.map(([term, value]) => (
				<div className="contents" key={term}>
					<dt className="font-bold">{term}</dt>
					<dd className="break-words">{value}</dd>
				</div>
			))}
		</dl>
	);
}

function Outcome({ outcome }: { outcome: EmergencyOutcome }) {
	if (outcome.action === "check_in") return null;
	const family =
		outcome.family === null
			? null
			: outcome.family.status === "raised"
				? "Your family got an alert."
				: `Your family was not alerted: ${outcome.family.message}`;
	if (outcome.action === "dispatch")
		return (
			<div className="grid gap-2" role="status">
				<p className="font-semibold text-[22px]">
					{outcome.call.outcome === "connected"
						? "Practice call connected (simulated)."
						: "Practice call failed (simulated). Get help another way."}
				</p>
				<p className="text-[16px]">
					No real call was made. Your care record was not sent to a dispatcher.
					In a real call, follow the dispatcher's instructions.
				</p>
				<p className="text-[16px]">{family}</p>
				<HandoffList handoff={outcome.handoff} />
			</div>
		);
	return (
		<div className="grid gap-2" role="status">
			<p className="font-semibold text-[22px]">
				{outcome.action === "family"
					? "I told your family."
					: outcome.reason === "denied"
						? "OK. I won't call for help."
						: "This is not an emergency by itself."}
			</p>
			{family !== null && <p className="text-[16px]">{family}</p>}
			{outcome.action === "none" && (
				<p className="text-[16px]">
					Nothing here confirms you are safe. Ask for help any time.
				</p>
			)}
		</div>
	);
}

export function useEmergency(familyId: string | null): EmergencyFlow {
	const [step, setStep] = useState<Step>({ kind: "idle" });

	const post = useCallback(
		async (path: string, body: unknown, deadline: number) => {
			if (familyId === null)
				return setStep({ kind: "failed", failure: { kind: "signed_out" } });
			const result = await apiRequest(
				EmergencyOutcome,
				familyPath(familyId, path),
				{ method: "POST", body },
			);
			if (result.kind !== "ready")
				return setStep({ kind: "failed", failure: result });
			const outcome = result.value;
			setStep(
				outcome.action === "check_in"
					? {
							kind: "checking",
							prompt: outcome.prompt,
							event: outcome.event,
							deadline,
						}
					: { kind: "done", outcome },
			);
		},
		[familyId],
	);

	const help = async (report: string | null) => {
		setStep({ kind: "calling", what: "help" });
		await post(
			"/emergency",
			{ kind: "help", report, wearer: WEARER, location: await locate() },
			0,
		);
	};

	const reply = useCallback(
		async (event: CheckInEvent, deadline: number, text: string | null) => {
			setStep({ kind: "calling", what: "check_in" });
			await post(
				"/emergency/check-in",
				{
					event,
					reply:
						text === null
							? { kind: "no_response", waitedSeconds: CHECK_IN_MS / 1000 }
							: { kind: "speech", speaker: "wearer", text },
					wearer: WEARER,
					location: await locate(),
				},
				deadline,
			);
		},
		[post],
	);

	// No answer by the deadline is "no response": the server dispatches.
	useEffect(() => {
		if (step.kind !== "checking") return;
		const timer = setTimeout(
			() => void reply(step.event, step.deadline, null),
			Math.max(0, step.deadline - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [step, reply]);

	const start = (intent: EmergencyIntent, report: string) => {
		if (intent === "help") return void help(report);
		setStep({ kind: "calling", what: "check_in" });
		void post(
			"/emergency",
			{
				kind: "event",
				event: { kind: intent, report, observedAt: new Date().toISOString() },
			},
			Date.now() + CHECK_IN_MS,
		);
	};

	const family = () => {
		setStep({ kind: "calling", what: "family" });
		void post("/emergency", { kind: "family", report: null }, 0);
	};

	return { step, help, reply, start, family };
}

/**
 * Call emergency help, Call my family, and the check-in after an "ouch" or a fall. Every call is
 * simulated and says so. Automatic detection is not a source: there is no test-fall button (issue #6).
 */
export function Emergency({
	familyId,
	emergency: { step, help, reply, family },
}: {
	familyId: string | null;
	emergency: EmergencyFlow;
}) {
	const off = familyId === null || step.kind === "calling";
	return (
		<section aria-label="Emergency" className="win95-raised grid gap-3 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="font-bold text-[22px]">Emergency</h2>
				<Hint
					text="Calls are simulated."
					align="end"
					className="win95-inset bg-[#ffffe1] px-2 py-0.5 font-bold text-[14px] text-black"
				>
					Practice mode
				</Hint>
			</div>

			{step.kind === "checking" ? (
				<div className="grid gap-2" role="alertdialog" aria-label="Check-in">
					<p className="font-semibold text-[24px]">{step.prompt}</p>
					<p className="text-[16px]">
						If you don't answer in {CHECK_IN_MS / 1000} seconds, I'll call for
						help (simulated) and tell your family.
					</p>
					<div className="grid grid-cols-2 gap-2">
						<Button
							className={`${xl} font-bold text-destructive!`}
							onClick={() =>
								void reply(step.event, step.deadline, "I need help")
							}
						>
							I need help
						</Button>
						<Button
							className={xl}
							onClick={() => void reply(step.event, step.deadline, "I'm OK")}
						>
							I'm OK
						</Button>
					</div>
				</div>
			) : (
				<div className="grid gap-2 sm:grid-cols-2">
					<Button
						className={`${xl} font-bold text-destructive!`}
						disabled={off}
						onClick={() => void help(null)}
					>
						{step.kind === "calling" && step.what === "help" ? (
							<Loader2 aria-hidden className="animate-spin" />
						) : (
							<Siren aria-hidden />
						)}
						Call emergency help
					</Button>
					<Button className={xl} disabled={off} onClick={family}>
						{step.kind === "calling" && step.what === "family" ? (
							<Loader2 aria-hidden className="animate-spin" />
						) : (
							<Users aria-hidden />
						)}
						Call my family
					</Button>
				</div>
			)}

			{familyId === null && (
				<p className="text-[16px]">
					Emergency calls need a paired person and sign-in.
				</p>
			)}
			{step.kind === "calling" && (
				<p className="flex items-center gap-2 text-[18px]" role="status">
					<Phone aria-hidden className="size-5" />
					{step.what === "family"
						? "Telling your family…"
						: "Connecting (simulated)…"}
				</p>
			)}
			{step.kind === "done" && <Outcome outcome={step.outcome} />}
			{step.kind === "failed" && (
				<p className="text-[18px] text-destructive" role="alert">
					The request did not go through
					{step.failure.kind === "signed_out"
						? ": sign in first."
						: `: ${step.failure.message}`}{" "}
					Get help another way.
				</p>
			)}
		</section>
	);
}
