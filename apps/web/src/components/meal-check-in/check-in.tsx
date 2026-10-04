// The wearer's meal or drink check-in on the home screen (#32). Every answer goes through the shared
// reminder lifecycle (#28); a request for a person also opens a care need for the family ladder (#30).
import { CareNeed, type NewCareNeed } from "@health/contracts/care";
import { CareProfileRecord } from "@health/contracts/care-profile";
import {
	type ReminderAnswerInput,
	type ReminderDeliveryInput,
	ReminderHistory,
	type ReminderOccurrence,
	ReminderOccurrenceDetail,
	type ReminderResponse,
} from "@health/contracts/reminders";
import { Button } from "@health/ui/components/button";
import { Check, Clock, CupSoda, Send, Utensils, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { apiRequest, familyPath, useApi } from "@/lib/api";

import {
	BARRIERS,
	type Barrier,
	barrierWords,
	dueCheckIn,
	type MealKind,
	nextSteps,
	reportsUrgentSymptom,
	restrictionsFor,
	type Step,
	stepResponse,
} from "./logic";

const lg = "h-14 w-full text-[20px] [&_svg]:size-6";

export function MealCheckIn({
	familyId,
	now,
	onUrgent,
}: {
	familyId: string;
	now: number;
	/** Opens the separate help path (#34) with the wearer's words. */
	onUrgent: (words: string) => void;
}) {
	const [refresh, setRefresh] = useState(0);
	const history = useApi(
		ReminderHistory,
		familyPath(familyId, "/reminder-occurrences"),
		{ pollMs: 15_000, refreshKey: refresh },
	);
	const due = history.kind === "ready" ? dueCheckIn(history.value, now) : null;
	const delivery = due === null ? null : `${due.id}-${due.prompts}`;

	// Records once per prompt that this screen showed it; the id makes a resend record nothing new.
	useEffect(() => {
		if (due === null || !due.promptDue || delivery === null) return;
		void apiRequest(
			ReminderOccurrenceDetail,
			familyPath(familyId, `/reminder-occurrences/${due.id}/deliveries`),
			{
				method: "POST",
				body: {
					clientId: `web-${delivery}`,
					source: "web",
				} satisfies ReminderDeliveryInput,
			},
		).then((result) => result.kind === "ready" && setRefresh((n) => n + 1));
	}, [familyId, due, delivery]);

	if (history.kind !== "ready" && history.kind !== "loading")
		return (
			<p className="win95-inset bg-card p-3 text-[18px]" role="status">
				Meal and drink check-ins are not available right now.
			</p>
		);
	if (due === null || !(due.kind === "meal" || due.kind === "hydration"))
		return null;
	return (
		<Prompt
			key={due.id}
			familyId={familyId}
			kind={due.kind}
			occurrence={due}
			onAnswered={() => setRefresh((n) => n + 1)}
			onUrgent={onUrgent}
		/>
	);
}

type Status =
	| { readonly kind: "idle" }
	| { readonly kind: "sending" }
	| { readonly kind: "failed"; readonly message: string };

function Prompt({
	familyId,
	kind,
	occurrence,
	onAnswered,
	onUrgent,
}: {
	familyId: string;
	kind: MealKind;
	occurrence: ReminderOccurrence;
	onAnswered: () => void;
	onUrgent: (words: string) => void;
}) {
	const [words, setWords] = useState("");
	const [barrier, setBarrier] = useState<Barrier | "choose" | null>(null);
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	// One id per answer, kept across resends, so a retry after a lost reply records one event.
	const clientId = useRef(crypto.randomUUID());
	const meal = kind === "meal";
	const path = familyPath(familyId, `/reminder-occurrences/${occurrence.id}`);

	const answer = async (response: ReminderResponse, wording: string) => {
		const result = await apiRequest(
			ReminderOccurrenceDetail,
			`${path}/answers`,
			{
				method: "POST",
				body: {
					clientId: clientId.current,
					source: "web",
					response,
					wording: wording === "" ? null : wording,
				} satisfies ReminderAnswerInput,
			},
		);
		if (result.kind !== "ready")
			return result.kind === "signed_out"
				? "Sign in to answer."
				: result.message;
		clientId.current = crypto.randomUUID();
		return null;
	};

	const send = async (
		response: ReminderResponse,
		wording: string,
		person: boolean,
	) => {
		setStatus({ kind: "sending" });
		let failed = await answer(response, wording);
		// One care need per check-in: its id is the occurrence, so a resend stores it once.
		if (failed === null && person) {
			const need = await apiRequest(
				CareNeed,
				familyPath(familyId, "/care/needs"),
				{
					method: "POST",
					body: {
						clientId: `reminder-${occurrence.id}`,
						kind: "help",
						summary:
							`${occurrence.title}: ${wording || "asked for help"}`.slice(
								0,
								500,
							),
						sampleIds: [],
						dueAt: null,
					} satisfies NewCareNeed,
				},
			);
			if (need.kind !== "ready")
				failed = `Your family was not asked: ${need.kind === "signed_out" ? "sign in first" : need.message}`;
		}
		if (failed !== null) return setStatus({ kind: "failed", message: failed });
		setStatus({ kind: "idle" });
		onAnswered();
	};

	const take = (step: Step, wording: string) => {
		if (step.action === "now") return setBarrier(null);
		if (step.action === "help_path") onUrgent(wording);
		const response = stepResponse[step.action];
		if (response !== null)
			void send(response, wording, step.action === "caregiver");
	};

	const said = words.trim();
	const sending = status.kind === "sending";
	return (
		<section
			aria-labelledby="meal-check-in"
			className="win95-raised grid gap-3 p-4 text-[20px]"
		>
			<h2
				className="flex items-center gap-2 font-semibold text-[22px]"
				id="meal-check-in"
			>
				{meal ? <Utensils aria-hidden /> : <CupSoda aria-hidden />}
				{occurrence.title}
			</h2>
			<Notes familyId={familyId} kind={kind} />

			{barrier === null && (
				<div className="grid gap-2 sm:grid-cols-2">
					<Button
						className={`win95-primary ${lg}`}
						disabled={sending}
						onClick={() => void send("done", said, false)}
					>
						<Check aria-hidden />
						{meal ? "I ate" : "I had a drink"}
					</Button>
					<Button
						className={lg}
						disabled={sending}
						onClick={() => void send("later", said, false)}
						variant="outline"
					>
						<Clock aria-hidden />
						Later
					</Button>
					<Button
						className={lg}
						disabled={sending}
						onClick={() => setBarrier("choose")}
						variant="outline"
					>
						Something is in the way
					</Button>
					<Button
						className={lg}
						disabled={sending}
						onClick={() => void send("stop", said, false)}
						variant="outline"
					>
						<X aria-hidden />
						Not this time
					</Button>
				</div>
			)}

			{barrier === "choose" && (
				<fieldset className="grid gap-2 sm:grid-cols-2">
					<legend className="mb-2">What is in the way?</legend>
					{BARRIERS.map((b) => (
						<Button
							className={lg}
							key={b}
							onClick={() => setBarrier(b)}
							variant="outline"
						>
							{barrierWords(b, kind)}
						</Button>
					))}
				</fieldset>
			)}

			{barrier !== null && barrier !== "choose" && (
				<div className="grid gap-2">
					<p>
						You said: <b>{barrierWords(barrier, kind)}</b>
					</p>
					{nextSteps(barrier, kind).map((step) => (
						<Button
							className={
								step.action === "help_path" ? `win95-primary ${lg}` : lg
							}
							disabled={sending}
							key={step.action}
							onClick={() =>
								take(
									step,
									said === ""
										? barrierWords(barrier, kind)
										: `${barrierWords(barrier, kind)}: ${said}`,
								)
							}
							variant={step.action === "help_path" ? "default" : "outline"}
						>
							{step.label}
						</Button>
					))}
				</div>
			)}
			{barrier !== null && (
				<Button
					className="h-12 text-[18px]"
					onClick={() => setBarrier(null)}
					variant="ghost"
				>
					Back
				</Button>
			)}

			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (said === "") return;
					if (reportsUrgentSymptom(said)) {
						onUrgent(said);
						void send("help", said, false);
					} else setBarrier("choose");
				}}
			>
				<label className="sr-only" htmlFor="meal-words">
					Tell me in your words
				</label>
				<input
					className="win95-inset win95-field h-14 min-w-0 flex-1 bg-white px-3 text-[18px] text-black"
					id="meal-words"
					maxLength={1500}
					onChange={(event) => setWords(event.target.value)}
					placeholder="Or tell me in your words"
					value={words}
				/>
				<Button
					aria-label="Send"
					className="h-14 w-14 [&_svg]:size-6"
					title="Send"
					type="submit"
					variant="outline"
				>
					<Send aria-hidden />
				</Button>
			</form>

			<p aria-live="polite" className="text-[16px]">
				{status.kind === "sending" && "Saving…"}
				{status.kind === "failed" && `Not saved: ${status.message}`}
			</p>
		</section>
	);
}

/** The wearer's saved diet or fluid notes. Unknown says unknown; there is no general water target. */
function Notes({ familyId, kind }: { familyId: string; kind: MealKind }) {
	const profile = useApi(
		CareProfileRecord,
		familyPath(familyId, "/care-profile"),
	);
	return (
		<div className="text-[16px] text-muted-foreground">
			{profile.kind === "loading" ? null : profile.kind !== "ready" ? (
				<p>
					Your diet and fluid notes cannot be read:{" "}
					{profile.kind === "signed_out" ? "sign in first" : profile.message}
				</p>
			) : (
				restrictionsFor(profile.value.profile, kind).map(({ label, items }) => (
					<p key={label}>
						{label}:{" "}
						{items === null
							? "not known"
							: items.length === 0
								? "none"
								: items.join("; ")}
					</p>
				))
			)}
			{kind === "hydration" && (
				<p>
					I follow only your agreed drink times, not a general water target.
				</p>
			)}
		</div>
	);
}
