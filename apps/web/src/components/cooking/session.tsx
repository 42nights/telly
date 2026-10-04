import type { MealSuggestion } from "@health/contracts/cooking";
import { Button, buttonVariants } from "@health/ui/components/button";
import { Link } from "@tanstack/react-router";
import {
	ArrowRight,
	HandHelping,
	Info,
	Pause,
	Play,
	Repeat,
	Square,
} from "lucide-react";
import { useState } from "react";

import { SpeechLine, useSpeech } from "@/components/wearer/speech";
import { apiRequest, familyPath } from "@/lib/api";

import { advance, type SessionAction, startSession } from "./logic";

const control = "h-14 text-[18px] [&_svg]:size-5";

const taskNames = {
	stove: "the stove",
	oven: "the oven",
	microwave: "the microwave",
	toaster: "the toaster",
	knife: "a sharp knife",
} as const;

/** Sends one family chat message asking for help. A failure says so; it is never shown as sent. */
function AskForHelp({
	familyId,
	request,
}: {
	familyId: string | null;
	request: string;
}) {
	const [state, setState] = useState<
		"idle" | "sending" | "sent" | { problem: string }
	>("idle");
	// One id per request, reused on retry, so a resend after a lost reply is stored once.
	const [clientId] = useState(() => crypto.randomUUID());
	const send = async () => {
		if (familyId === null)
			return setState({ problem: "No person is paired yet." });
		setState("sending");
		const result = await apiRequest(null, familyPath(familyId, "/messages"), {
			method: "POST",
			body: { clientId, body: request },
		});
		setState(
			result.kind === "ready"
				? "sent"
				: {
						problem:
							result.kind === "signed_out"
								? "Sign in to message your family."
								: `Your family did not get the message. ${result.message}`,
					},
		);
	};
	return (
		<div className="grid gap-1">
			<Button
				className={control}
				disabled={state === "sending" || state === "sent"}
				onClick={() => void send()}
				variant="outline"
			>
				<HandHelping aria-hidden />
				{state === "sent" ? "Help asked" : "Ask my family for help"}
			</Button>
			{state === "sent" && (
				<p className="text-[16px]" role="status">
					Your family can see your message in the family chat.
				</p>
			)}
			{typeof state === "object" && (
				<p className="text-[16px] text-destructive" role="alert">
					{state.problem}
				</p>
			)}
		</div>
	);
}

/** Reads the step aloud. Unmounting it (pause, next step) stops the voice. */
function StepVoice({
	familyId,
	text,
}: {
	familyId: string | null;
	text: string;
}) {
	const { speech, say } = useSpeech(familyId);
	return (
		<div className="grid gap-1">
			<Button
				className={control}
				onClick={() => void say(text, text)}
				variant="outline"
			>
				<Repeat aria-hidden />
				Repeat
			</Button>
			<SpeechLine speech={speech} />
		</div>
	);
}

/** One recipe, one step at a time, at the wearer's pace. */
export function CookingSession({
	familyId,
	meal,
	onDone,
}: {
	familyId: string | null;
	meal: MealSuggestion;
	onDone: () => void;
}) {
	const [session, setSession] = useState(startSession);
	const act = (action: SessionAction) =>
		setSession((s) => advance(s, action, meal.steps));
	const step = meal.steps[session.step] ?? meal.steps[0];
	const helpText = `I need help cooking ${meal.name}, step ${session.step + 1}: “${step.text}”`;

	if (session.ended === "finished")
		return (
			<div className="grid gap-3 text-[18px]" aria-live="polite">
				<p className="font-semibold text-[22px]">You finished {meal.name}.</p>
				<p>
					Check that the stove and the oven are off. I cannot see them, and I do
					not know if you ate the meal.
				</p>
				<p>Do you want to record this meal?</p>
				<div className="grid gap-2 sm:grid-cols-2">
					<Link
						className={buttonVariants({
							className: `win95-primary ${control}`,
						})}
						data-slot="button"
						search={{ dish: meal.name }}
						to="/meal"
					>
						Yes, record it
					</Link>
					<Button className={control} onClick={onDone} variant="outline">
						Not now
					</Button>
				</div>
			</div>
		);

	if (session.ended === "stopped")
		return (
			<div className="grid gap-3 text-[18px]" aria-live="polite">
				<p className="font-semibold text-[22px]">You stopped cooking.</p>
				<p>
					Turn off anything you turned on. Check the stove and the oven. I
					cannot see them.
				</p>
				<AskForHelp
					familyId={familyId}
					request={`I stopped cooking ${meal.name} at step ${session.step + 1}. Can someone check on me?`}
				/>
				<Button className={control} onClick={onDone} variant="outline">
					Choose another meal
				</Button>
			</div>
		);

	return (
		<div className="grid gap-3">
			<p className="text-[16px] text-muted-foreground">
				I cannot see your stove or your food. I cannot tell you that they are
				safe.
			</p>
			<p className="font-bold text-[16px]">
				{meal.name} · Step {session.step + 1} of {meal.steps.length}
			</p>
			<p
				aria-live="polite"
				className="win95-inset bg-white p-3 text-[24px] text-black leading-snug"
			>
				{step.text}
			</p>
			{session.explaining && (
				<p className="win95-inset bg-card p-3 text-[18px]">{step.explain}</p>
			)}
			{step.helper && step.task !== null && (
				<div
					className="win95-inset grid gap-2 bg-card p-3 text-[18px]"
					role="note"
				>
					<p className="font-semibold">
						This step uses {taskNames[step.task]}. Your family agreed that a
						helper is with you for it.
					</p>
					<AskForHelp
						familyId={familyId}
						key={session.step}
						request={helpText}
					/>
					<Button
						aria-pressed={session.helperHere}
						className={control}
						disabled={session.paused || session.helperHere}
						onClick={() => act("helper_here")}
						variant="outline"
					>
						{session.helperHere ? "Your helper is here" : "My helper is here"}
					</Button>
				</div>
			)}
			{session.paused ? (
				<p className="text-[18px]" role="status">
					Paused. Press Resume when you are ready.
				</p>
			) : (
				<StepVoice familyId={familyId} key={session.step} text={step.text} />
			)}
			<div className="grid grid-cols-2 gap-2">
				<Button
					className={control}
					disabled={session.paused}
					onClick={() => act("explain")}
					variant="outline"
				>
					<Info aria-hidden />
					{session.explaining ? "Hide" : "Explain"}
				</Button>
				<Button
					className={control}
					onClick={() => act(session.paused ? "resume" : "pause")}
					variant="outline"
				>
					{session.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
					{session.paused ? "Resume" : "Pause"}
				</Button>
				<Button
					className={control}
					onClick={() => act("stop")}
					variant="outline"
				>
					<Square aria-hidden />
					Stop
				</Button>
				<Button
					className={`win95-primary ${control}`}
					disabled={session.paused || (step.helper && !session.helperHere)}
					onClick={() => act("next")}
				>
					<ArrowRight aria-hidden />
					{session.step + 1 === meal.steps.length ? "Done" : "Next"}
				</Button>
			</div>
		</div>
	);
}
