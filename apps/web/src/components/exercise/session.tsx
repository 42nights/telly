// The wearer's guided exercise (#41): an invitation to one verified, agreed activity, then its steps
// one at a time with video when the plan has one, the voice, and the text. Pause, repeat, slower,
// stop, and help stay on screen for the whole session. Every answer is recorded as itself; closing
// the screen without an answer records nothing, so it never counts as exercise done.
import {
	type ExerciseEventInput,
	type ExercisePlan,
	ExerciseRecords,
	ExerciseSession,
	type StopReason,
} from "@health/contracts/exercise";
import { Button } from "@health/ui/components/button";
import {
	Activity,
	Glasses,
	Hand,
	LifeBuoy,
	Pause,
	Play,
	Repeat,
	Snail,
	Square,
} from "lucide-react";
import { type RefObject, useRef, useState } from "react";

import { xl } from "@/components/wearer/answer";
import { type Speech, SpeechLine, useSpeech } from "@/components/wearer/speech";
import { apiRequest, familyPath, useApi } from "@/lib/api";

import { invitation } from "./logic";

const SLOW = 0.75;
const control = "h-14 text-[18px] [&_svg]:size-6";

type Running = {
	readonly kind: "running";
	readonly step: number;
	readonly paused: boolean;
	readonly slow: boolean;
};

type Phase =
	| { readonly kind: "invited" }
	| Running
	| {
			readonly kind: "ended";
			readonly outcome: "declined" | "stopped" | "completed";
			readonly reason: StopReason | null;
	  };

function HelpNote() {
	return (
		<div className="win95-inset grid gap-1 bg-white p-3 text-[18px] text-black">
			<p className="font-semibold">Sit down somewhere safe and rest.</p>
			<p>Tell someone near you. Your family can see this in the history.</p>
			<p>If you feel very unwell, call your local emergency number now.</p>
		</div>
	);
}

const endText = {
	declined: "That's fine. I won't ask again today.",
	completed: "You finished the activity. Your family can see it.",
	stopped: "You stopped the activity. Your family can see it.",
} as const;

/** The current step: the source's video when it loads, else words and voice only. */
function Guide({
	plan,
	running,
	speech,
	video,
}: {
	plan: ExercisePlan;
	running: Running;
	speech: Speech;
	video: RefObject<HTMLVideoElement | null>;
}) {
	const [videoFailed, setVideoFailed] = useState(false);
	return (
		<>
			{plan.videoUrl !== null && !videoFailed ? (
				// Muted: the voice reads the steps, and the step text below is the caption.
				<video
					autoPlay
					className="win95-inset w-full bg-black"
					controls
					loop
					muted
					onError={() => setVideoFailed(true)}
					playsInline
					ref={video}
					src={plan.videoUrl}
				/>
			) : (
				<p className="text-[16px]">
					{plan.videoUrl === null
						? "This activity has no video. Follow the words and the voice."
						: "The video did not load. Follow the words and the voice."}
				</p>
			)}
			<p className="text-[15px] text-muted-foreground">
				<Glasses aria-hidden className="mr-1 inline size-4" />
				Glasses video is off until the glasses are proven to show it.
			</p>
			<p className="font-semibold text-[16px]">
				Step {running.step + 1} of {plan.steps.length}
				{running.paused ? " · Paused" : ""}
				{running.slow ? " · Slower" : ""}
			</p>
			<p
				aria-live="polite"
				className="win95-inset bg-white p-3 text-[24px] text-black leading-snug"
			>
				{plan.steps[running.step]}
			</p>
			<SpeechLine speech={speech} />
		</>
	);
}

type Actions = {
	readonly pause: () => void;
	readonly repeat: () => void;
	readonly slower: () => void;
	readonly help: () => void;
	readonly stop: (reason: StopReason) => void;
	readonly next: () => void;
};

/** Every session control, on screen for the whole session. */
function Controls({
	running,
	last,
	act,
}: {
	running: Running;
	last: boolean;
	act: Actions;
}) {
	return (
		<>
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
				<Button className={control} variant="outline" onClick={act.pause}>
					{running.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
					{running.paused ? "Resume" : "Pause"}
				</Button>
				<Button className={control} variant="outline" onClick={act.repeat}>
					<Repeat aria-hidden />
					Repeat
				</Button>
				<Button
					className={control}
					disabled={running.slow}
					variant="outline"
					onClick={act.slower}
				>
					<Snail aria-hidden />
					Slower
				</Button>
				<Button className={control} variant="outline" onClick={act.help}>
					<LifeBuoy aria-hidden />
					Help
				</Button>
				<Button
					className={control}
					variant="outline"
					onClick={() => act.stop("wearer")}
				>
					<Square aria-hidden />
					Stop
				</Button>
				<Button
					className={`win95-primary ${control}`}
					disabled={running.paused}
					onClick={act.next}
				>
					{last ? "I finished" : "Next step"}
				</Button>
			</div>
			<fieldset className="grid gap-2">
				<legend className="mb-1 flex items-center gap-1 font-semibold text-[18px]">
					<Hand aria-hidden className="size-5" />
					Something wrong? Stop now:
				</legend>
				<div className="grid grid-cols-3 gap-2">
					{(
						[
							["pain", "Pain"],
							["dizziness", "Dizzy"],
							["distress", "Unwell"],
						] as const
					).map(([reason, label]) => (
						<Button
							className="h-14 text-[18px]"
							key={reason}
							variant="destructive"
							onClick={() => act.stop(reason)}
						>
							{label}
						</Button>
					))}
				</div>
			</fieldset>
		</>
	);
}

function Session({
	familyId,
	plan,
	onEngage,
	onClose,
}: {
	familyId: string;
	plan: ExercisePlan;
	/** The wearer answered, so the invitation must not change under the session. */
	onEngage: () => void;
	onClose: () => void;
}) {
	const [phase, setPhase] = useState<Phase>({ kind: "invited" });
	const [help, setHelp] = useState(false);
	const [problem, setProblem] = useState<{
		readonly message: string;
		readonly event: ExerciseEventInput;
		readonly then: Phase;
	} | null>(null);
	const sessionId = useRef(crypto.randomUUID());
	const video = useRef<HTMLVideoElement>(null);
	const { speech, say, stop } = useSpeech(familyId);

	const speak = (step: number, slow: boolean) =>
		void say(`exercise-${step}`, plan.steps[step] ?? "", { slow });

	/** Sends one event; a failed send keeps its id, so "Try again" cannot record it twice. */
	const send = async (event: ExerciseEventInput, then: Phase) => {
		setProblem(null);
		const result = await apiRequest(
			ExerciseSession,
			familyPath(familyId, "/exercise/events"),
			{ method: "POST", body: event },
		);
		if (result.kind !== "ready") {
			const message =
				result.kind === "signed_out"
					? "Sign in again to save this."
					: `This was not saved. ${result.message}`;
			setProblem({ message, event, then });
			return false;
		}
		setPhase(then);
		return true;
	};
	const record = (
		kind: ExerciseEventInput["kind"],
		then: Phase,
		reason: StopReason | null = null,
	) => {
		onEngage();
		const id = crypto.randomUUID();
		const event = { id, planId: plan.id, sessionId: sessionId.current };
		return send({ ...event, kind, reason }, then);
	};

	const actions = (running: Running): Actions => ({
		pause: async () => {
			const paused = !running.paused;
			const kind = paused ? "paused" : "resumed";
			if (!(await record(kind, { ...running, paused }))) return;
			stop();
			video.current?.pause();
			if (!paused) {
				speak(running.step, running.slow);
				void video.current?.play().catch(() => {});
			}
		},
		repeat: async () => {
			if (!(await record("repeated", { ...running, paused: false }))) return;
			speak(running.step, running.slow);
			if (video.current !== null) video.current.currentTime = 0;
			void video.current?.play().catch(() => {});
		},
		slower: async () => {
			if (!(await record("slowed", { ...running, slow: true }))) return;
			if (video.current !== null) video.current.playbackRate = SLOW;
			speak(running.step, true);
		},
		help: () => {
			setHelp(true);
			void record("help", running);
		},
		stop: (reason) => {
			stop();
			video.current?.pause();
			// Safety comes first: the help text shows even when saving the stop fails.
			if (reason !== "wearer") setHelp(true);
			const ended = { kind: "ended", outcome: "stopped", reason } as const;
			void record("stopped", ended, reason);
		},
		next: () => {
			if (running.step < plan.steps.length - 1) {
				setPhase({ ...running, step: running.step + 1 });
				speak(running.step + 1, running.slow);
				return;
			}
			stop();
			const ended = {
				kind: "ended",
				outcome: "completed",
				reason: null,
			} as const;
			void record("completed", ended);
		},
	});

	const start = async () => {
		const first = {
			kind: "running",
			step: 0,
			paused: false,
			slow: false,
		} as const;
		if (await record("started", first)) speak(0, false);
	};

	return (
		<section
			aria-label="Exercise"
			className="win95-raised grid gap-3 bg-card p-3"
		>
			<h2 className="flex items-center gap-2 font-bold text-[24px]">
				<Activity aria-hidden className="size-7" />
				{plan.activity}
			</h2>
			<p className="text-[15px] text-muted-foreground">
				Agreed activity from: {plan.source}
			</p>

			{phase.kind === "invited" && (
				<>
					<p className="text-[20px]">Would you like to do it now?</p>
					<div className="grid grid-cols-2 gap-2">
						<Button className={`win95-primary ${xl}`} onClick={start}>
							<Play aria-hidden />
							Start
						</Button>
						<Button
							className={xl}
							variant="outline"
							onClick={() =>
								record("declined", {
									kind: "ended",
									outcome: "declined",
									reason: null,
								})
							}
						>
							Not now
						</Button>
					</div>
				</>
			)}

			{phase.kind === "running" && (
				<>
					<Guide plan={plan} running={phase} speech={speech} video={video} />
					<Controls
						act={actions(phase)}
						last={phase.step === plan.steps.length - 1}
						running={phase}
					/>
				</>
			)}

			{help && <HelpNote />}

			{problem !== null && (
				<div className="grid gap-2" role="alert">
					<p className="text-[18px] text-destructive">{problem.message}</p>
					<Button
						className="h-12 text-[18px]"
						variant="outline"
						onClick={() => send(problem.event, problem.then)}
					>
						Try again
					</Button>
				</div>
			)}

			{phase.kind === "ended" && (
				<>
					<p className="text-[20px]" role="status">
						{endText[phase.outcome]}
					</p>
					<Button className={control} variant="outline" onClick={onClose}>
						Close
					</Button>
				</>
			)}
		</section>
	);
}

/**
 * Invites the wearer to a verified, agreed activity during its time window. Shows nothing when no
 * activity is due; an unreadable list shows as unavailable, not as "nothing to do".
 */
export function ExerciseInvite({
	familyId,
	now,
}: {
	familyId: string;
	now: number;
}) {
	const records = useApi(ExerciseRecords, familyPath(familyId, "/exercise"), {
		pollMs: 60_000,
	});
	const [active, setActive] = useState<ExercisePlan | null>(null);
	const [answered, setAnswered] = useState<readonly string[]>([]);
	if (records.kind === "loading" || records.kind === "signed_out") return null;
	if (records.kind !== "ready")
		return (
			<p className="text-[16px] text-muted-foreground">
				Exercise invitations are unavailable: {records.message}
			</p>
		);
	const plan =
		active ??
		invitation(
			records.value.plans.filter((p) => !answered.includes(p.id)),
			records.value.sessions,
			new Date(now),
		);
	if (plan === null) return null;
	return (
		<Session
			familyId={familyId}
			key={plan.id}
			plan={plan}
			onEngage={() => setActive(plan)}
			onClose={() => {
				setAnswered((ids) => [...ids, plan.id]);
				setActive(null);
			}}
		/>
	);
}
