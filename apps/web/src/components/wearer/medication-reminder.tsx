// The wearer's medication reminders on the HUD (#31). The lifecycle is #28's: this panel shows a
// due medication occurrence, records that it was shown, and records exactly what the wearer
// pressed. The instruction comes only from the verified #26 plan. Help goes to the #30 ladder.
import { CareNeed } from "@health/contracts/care";
import { CareInstructions } from "@health/contracts/care-profile";
import { Me } from "@health/contracts/families";
import {
	ReminderHistory,
	type ReminderOccurrence,
	ReminderOccurrenceDetail,
	type ReminderResponse,
	type ReminderState,
} from "@health/contracts/reminders";
import { Button, buttonVariants } from "@health/ui/components/button";
import { Link } from "@tanstack/react-router";
import { Pill, Volume2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiNotice } from "@/components/win95";
import {
	type ApiFailure,
	type ApiState,
	apiRequest,
	familyPath,
	useApi,
} from "@/lib/api";
import { memberLabel } from "@/lib/members";

import {
	instructionInEffect,
	medicationPrompt,
	medicationReason,
	questionSummary,
	uncertaintyAnswer,
} from "./medication";
import { SpeechLine, useSpeech } from "./speech";

const big = "h-14 text-[20px] [&_svg]:size-6";
const DAY_MS = 24 * 60 * 60_000;
// The wearer's own answer ends these; every other state stays on screen.
const CLOSED: Partial<Record<ReminderState, true>> = {
	self_reported_complete: true,
	caregiver_confirmed: true,
	declined: true,
};

// Each button records its label as the wearer's words.
const ANSWERS: readonly (readonly [ReminderResponse, string])[] = [
	["done", "I took it"],
	["already_did_it", "I already took it"],
	["unsure", "I'm not sure if I took it"],
	["later", "Later"],
	["not_now", "Not now"],
	["stop", "No, thank you"],
	["help", "I need help"],
];

const time = (iso: string) =>
	new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const HELP_TEXT =
	"I can ask your family to help. I won't tell you whether to take a dose.";

// `prompt` and `why` read the plan at render time; the others keep the text they were given.
type Step =
	| { readonly kind: "prompt" | "why" }
	| { readonly kind: "unsure" | "help" | "asked"; readonly text: string };

const failureText = (r: ApiFailure, signedOut: string, failed: string) =>
	r.kind === "signed_out" ? signedOut : `${failed}: ${r.message}`;

/** The wearer's answers for one occurrence (#28) and the request to the family ladder (#30). */
function useOccurrenceActions(
	familyId: string,
	occurrence: ReminderOccurrence,
	me: string | null,
	onChange: () => void,
) {
	const [step, setStep] = useState<Step>({ kind: "prompt" });
	const [failure, setFailure] = useState<string | null>(null);
	// When the wearer said "not sure" or "help": the care need asks for that moment.
	const [askedAt, setAskedAt] = useState<string>();
	const path = familyPath(familyId, `/reminder-occurrences/${occurrence.id}`);

	// A device showed the due prompt. The id is fixed per prompt, so a resend records one event.
	useEffect(() => {
		if (!occurrence.promptDue) return;
		void apiRequest(ReminderOccurrenceDetail, `${path}/deliveries`, {
			method: "POST",
			body: {
				clientId: `show-${occurrence.id}-${occurrence.prompts}`,
				source: "web",
			},
		}).then((r) => r.kind === "ready" && onChange());
	}, [path, occurrence.id, occurrence.prompts, occurrence.promptDue, onChange]);

	const answer = async (response: ReminderResponse, words: string) => {
		setFailure(null);
		const result = await apiRequest(
			ReminderOccurrenceDetail,
			`${path}/answers`,
			{
				method: "POST",
				body: {
					clientId: crypto.randomUUID(),
					source: "web",
					response,
					wording: words,
				},
			},
		);
		if (result.kind !== "ready")
			return setFailure(
				failureText(
					result,
					"Sign in to record your answer.",
					"Your answer was not saved",
				),
			);
		if (response === "unsure" || response === "help") {
			setAskedAt(new Date().toISOString());
			const lines =
				response === "help"
					? [HELP_TEXT]
					: uncertaintyAnswer(
							result.value.occurrence,
							result.value.events,
							(actor) =>
								actor === "scheduler" ? "Telly" : memberLabel(actor, me),
							time,
						);
			setStep({ kind: response, text: lines.join("\n") });
		}
		onChange();
	};

	const askFamily = async () => {
		if (askedAt === undefined) return;
		setFailure(null);
		const result = await apiRequest(
			CareNeed,
			familyPath(familyId, "/care/needs"),
			{
				method: "POST",
				body: {
					clientId: `med-${occurrence.id}-${Date.parse(askedAt)}`,
					kind: "help",
					summary: questionSummary(occurrence, askedAt),
					sampleIds: [],
					dueAt: null,
				},
			},
		);
		if (result.kind !== "ready")
			return setFailure(
				failureText(
					result,
					"Sign in to ask your family.",
					"Your family was not asked",
				),
			);
		const contact = result.value.attempts.at(-1);
		setStep({
			kind: "asked",
			text:
				contact === undefined
					? "Nobody is set up to be contacted, so nobody was asked. Your question stays open for your family on the Care page."
					: `I asked ${contact.name}. Nobody has said they will help yet. Your question stays open until someone does.`,
		});
	};

	return { step, setStep, failure, answer, askFamily };
}

function Occurrence({
	familyId,
	occurrence,
	instructions,
	me,
	onChange,
}: {
	familyId: string;
	occurrence: ReminderOccurrence;
	instructions: ApiState<CareInstructions>;
	me: string | null;
	onChange: () => void;
}) {
	const { step, setStep, failure, answer, askFamily } = useOccurrenceActions(
		familyId,
		occurrence,
		me,
		onChange,
	);
	const { speech, say } = useSpeech(familyId);
	const instruction =
		instructions.kind === "ready"
			? instructionInEffect(
					occurrence,
					instructions.value.instructions,
					Date.now(),
				)
			: null;
	const spoken =
		"text" in step
			? step.text
			: step.kind === "prompt"
				? medicationPrompt(occurrence.title, instruction)
				: medicationReason(instruction);
	const atPrompt = step.kind === "prompt";
	return (
		<article className="win95-raised grid gap-3 p-3">
			<h3 className="font-bold text-[18px]">
				{occurrence.title} · {time(occurrence.scheduledFor)}
			</h3>
			<p
				aria-live="polite"
				className="whitespace-pre-line break-words text-[20px]"
			>
				{spoken}
			</p>
			{instructions.kind !== "ready" && instructions.kind !== "loading" && (
				<p className="text-[16px]" role="status">
					{failureText(
						instructions,
						"Sign in to read your medication plan.",
						"I can't read your medication plan",
					)}
				</p>
			)}
			{failure !== null && (
				<p className="text-[16px] text-destructive" role="alert">
					{failure}
				</p>
			)}
			<SpeechLine speech={speech} />
			<div className="flex flex-wrap gap-2">
				<Button
					className={big}
					onClick={() => void say(`med-${occurrence.id}`, spoken)}
					variant="outline"
				>
					<Volume2 aria-hidden />
					Read aloud
				</Button>
				{(step.kind === "unsure" || step.kind === "help") && (
					<Button
						className={`win95-primary ${big}`}
						onClick={() => void askFamily()}
					>
						Ask my family
					</Button>
				)}
				<Button
					className={big}
					onClick={() => setStep({ kind: atPrompt ? "why" : "prompt" })}
					variant="outline"
				>
					{atPrompt ? "Why do I take it?" : "Back"}
				</Button>
				<Link
					className={buttonVariants({ variant: "outline", className: big })}
					data-slot="button"
					search={{ q: `find my ${instruction?.name ?? occurrence.title}` }}
					to="/medicine"
				>
					<Pill aria-hidden />
					Find it
				</Link>
			</div>
			{atPrompt && (
				<div className="flex flex-wrap gap-2">
					{ANSWERS.map(([response, words]) => (
						<Button
							className={big}
							key={response}
							onClick={() => void answer(response, words)}
							variant="outline"
						>
							{words}
						</Button>
					))}
				</div>
			)}
		</article>
	);
}

/**
 * Medication reminders due in the last day that the wearer has not settled. Nothing shows when
 * none is due; a failed read shows as a failure, never as "no medication".
 */
export function MedicationReminders({ familyId }: { familyId: string }) {
	const [refresh, setRefresh] = useState(0);
	const onChange = useCallback(() => setRefresh((n) => n + 1), []);
	const history = useApi(
		ReminderHistory,
		familyPath(familyId, "/reminder-occurrences"),
		{ pollMs: 30_000, refreshKey: refresh },
	);
	const instructions = useApi(
		CareInstructions,
		familyPath(familyId, "/care-instructions"),
		{ pollMs: 5 * 60_000 },
	);
	const me = useApi(Me, "/api/me");
	if (history.kind === "loading") return null;
	if (history.kind !== "ready")
		return <ApiNotice state={history} what="medication reminders" />;
	const now = Date.now();
	const due = history.value.occurrences
		.map((d) => d.occurrence)
		.filter((o) => {
			const at = Date.parse(o.scheduledFor);
			return (
				o.kind === "medication" &&
				at <= now &&
				now - at < DAY_MS &&
				!CLOSED[o.state]
			);
		});
	if (due.length === 0) return null;
	return (
		<section aria-label="Medication" className="grid gap-2">
			{due.map((occurrence) => (
				<Occurrence
					familyId={familyId}
					instructions={instructions}
					key={occurrence.id}
					me={me.kind === "ready" ? me.value.identity : null}
					occurrence={occurrence}
					onChange={onChange}
				/>
			))}
		</section>
	);
}
