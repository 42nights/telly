import { FamilyAnswer, VoiceAnswer } from "@health/contracts/ask";
import { Button } from "@health/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Mic, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";

import { AnswerFailed, AnswerPanel, type Reply, xl } from "./answer";
import { isMedicineRequest } from "./logic";

// ponytail: fixed cap keeps a forgotten recording under the 10 MiB upload limit.
const MAX_RECORDING_MS = 60_000;

/** What the wearer asked: typed text, or a recording kept in memory until the next request. */
type Pending =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "voice"; readonly audio: Blob };

type Step =
	/** `draft` refills the text box, so a cancelled typed request is not lost. */
	| {
			readonly kind: "ready";
			readonly problem?: string;
			readonly draft?: string | undefined;
	  }
	| { readonly kind: "listening"; readonly stop: () => void }
	| {
			readonly kind: "thinking";
			readonly asked: string | null;
			readonly cancel: () => void;
	  }
	| { readonly kind: "answer"; readonly reply: Reply }
	| {
			readonly kind: "failed";
			readonly asked: string | null;
			readonly failure: ApiFailure;
			readonly request: Pending;
	  };

const failureTitle = {
	signed_out: "Sign in to ask questions.",
	forbidden: "You can't ask about this person.",
	unavailable: "Answers are not available right now.",
	error: "Something went wrong while getting the answer.",
} as const;

type Recording = { readonly stop: () => void; readonly cancel: () => void };

/** Records the microphone until stop (or the cap), then hands over the audio. A string is a problem. */
export const startRecording = async (
	onAudio: (audio: Blob) => void,
): Promise<Recording | string> => {
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (error) {
		const denied =
			error instanceof Error &&
			(error.name === "NotAllowedError" || error.name === "SecurityError");
		return denied
			? "Allow the microphone for this site, then press Talk again."
			: "No microphone is available. Type your question instead.";
	}
	const recorder = new MediaRecorder(stream);
	const chunks: Blob[] = [];
	recorder.ondataavailable = (event) => chunks.push(event.data);
	let cancelled = false;
	const stop = () => {
		clearTimeout(timer);
		for (const track of stream.getTracks()) track.stop();
		if (recorder.state !== "inactive") recorder.stop();
	};
	recorder.onstop = () => {
		if (!cancelled) onAudio(new Blob(chunks, { type: recorder.mimeType }));
	};
	const timer = setTimeout(stop, MAX_RECORDING_MS);
	recorder.start();
	return {
		stop,
		cancel: () => {
			cancelled = true;
			stop();
		},
	};
};

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Recording (`action` stops it) or waiting for the answer (`action` cancels and keeps the request). */
function Listening({
	thinking,
	action,
}: {
	thinking: boolean;
	action: () => void;
}) {
	return (
		<div
			aria-live="polite"
			className="grid justify-items-center gap-3 py-4 text-center"
		>
			<span className="win95-inset grid size-20 place-items-center bg-white">
				{thinking ? (
					<Loader2 aria-hidden className="size-10 animate-spin" />
				) : (
					<Mic aria-hidden className="size-10 text-[#000080]" />
				)}
			</span>
			<p className="font-semibold text-[22px]">
				{thinking ? "Thinking…" : "I'm listening…"}
			</p>
			<Button
				className="h-14 min-w-48 text-[20px] [&_svg]:size-6"
				onClick={action}
				variant="outline"
			>
				<Square aria-hidden />
				{thinking ? "Cancel" : "Stop"}
			</Button>
		</div>
	);
}

function AskForm({
	familyId,
	talkNote,
	problem,
	draft,
	onTalk,
	onAsk,
}: {
	familyId: string | null;
	talkNote: string;
	problem: string | undefined;
	draft: string | undefined;
	onTalk: () => void;
	onAsk: (text: string) => void;
}) {
	const [typed, setTyped] = useState(draft ?? "");
	return (
		<div className="grid gap-3">
			<h2 className="font-bold text-[26px]">What do you need?</h2>
			<Button
				className={`win95-primary ${xl}`}
				disabled={familyId === null}
				onClick={onTalk}
			>
				<Mic aria-hidden />
				Talk
			</Button>
			{familyId === null && <p className="text-[18px]">{talkNote}</p>}
			{problem !== undefined && (
				<p className="text-[18px] text-destructive" role="alert">
					{problem}
				</p>
			)}
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					onAsk(typed);
				}}
			>
				<label className="sr-only" htmlFor="wearer-request">
					Type a question
				</label>
				<input
					className="win95-inset win95-field h-14 min-w-0 flex-1 bg-white px-3 text-[18px] text-black"
					id="wearer-request"
					maxLength={2000}
					onChange={(event) => setTyped(event.target.value)}
					placeholder="Or type: “Where are my meds?”"
					value={typed}
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
		</div>
	);
}

/**
 * The wearer's request: Talk or a typed question. A medicine request opens the medicine finder;
 * any other question goes to Gemini (`POST /ask`, or `POST /ask/voice` for Talk). A failure shows
 * as a failure, never as an answer, and keeps the request for Try again.
 */
export function Request({
	familyId,
	talkNote,
}: {
	familyId: string | null;
	/** Why Talk is off while there is no family: loading, signed out, or none paired. */
	talkNote: string;
}) {
	const navigate = useNavigate();
	const [step, setStep] = useState<Step>({ kind: "ready" });
	/** Ends the recording or the request in progress. */
	const release = useRef(() => {});
	useEffect(() => () => release.current(), []);
	const done = () => setStep({ kind: "ready" });
	const openMedicine = (q: string) =>
		void navigate({ to: "/medicine", search: { q } });

	/** Shows "Thinking…" with Cancel; returns the signal for the request. */
	const think = (asked: string | null) => {
		const controller = new AbortController();
		release.current = () => controller.abort();
		setStep({
			kind: "thinking",
			asked,
			cancel: () => {
				controller.abort();
				setStep({ kind: "ready", draft: asked ?? undefined });
			},
		});
		return controller.signal;
	};

	const ask = async (text: string) => {
		const question = text.trim();
		if (question === "") return;
		if (isMedicineRequest(question)) return openMedicine(question);
		const request = { kind: "text", text: question } as const;
		if (familyId === null)
			return setStep({
				kind: "failed",
				asked: question,
				failure: { kind: "signed_out" },
				request,
			});
		const signal = think(question);
		const result = await apiRequest(
			FamilyAnswer,
			familyPath(familyId, "/ask"),
			{
				method: "POST",
				body: { question, timeZone: timeZone() },
				signal,
			},
		).catch(() => null);
		if (result === null) return;
		setStep(
			result.kind === "ready"
				? {
						kind: "answer",
						reply: {
							id: crypto.randomUUID(),
							asked: question,
							answer: result.value,
							audio: null,
							languageCode: null,
							voiceNote: null,
						},
					}
				: { kind: "failed", asked: question, failure: result, request },
		);
	};

	const askByVoice = async (audio: Blob) => {
		if (familyId === null) return;
		if (audio.size === 0)
			return setStep({
				kind: "ready",
				problem: "I didn't hear anything. Try again.",
			});
		const signal = think(null);
		const result = await apiRequest(
			VoiceAnswer,
			familyPath(
				familyId,
				`/ask/voice?timeZone=${encodeURIComponent(timeZone())}`,
			),
			{
				method: "POST",
				rawBody: { data: audio, type: audio.type || "audio/webm" },
				signal,
			},
		).catch(() => null);
		if (result === null) return;
		if (result.kind !== "ready")
			return setStep({
				kind: "failed",
				asked: null,
				failure: result,
				request: { kind: "voice", audio },
			});
		const { transcript, answer, speech } = result.value;
		if (isMedicineRequest(transcript.text))
			return openMedicine(transcript.text.trim());
		setStep({
			kind: "answer",
			reply: {
				id: crypto.randomUUID(),
				asked: transcript.text.trim(),
				answer,
				audio: speech.status === "ok" ? speech.audio : null,
				languageCode: transcript.languageCode,
				voiceNote:
					speech.status === "ok"
						? null
						: `No spoken answer this time: ${speech.message}`,
			},
		});
	};

	const talk = async () => {
		const recording = await startRecording((audio) => void askByVoice(audio));
		if (typeof recording === "string")
			return setStep({ kind: "ready", problem: recording });
		release.current = recording.cancel;
		setStep({ kind: "listening", stop: recording.stop });
	};

	switch (step.kind) {
		case "listening":
			return <Listening action={step.stop} thinking={false} />;
		case "thinking":
			return <Listening action={step.cancel} thinking />;
		case "answer":
			return (
				<AnswerPanel familyId={familyId} onDone={done} reply={step.reply} />
			);
		case "failed": {
			const { request } = step;
			return (
				<AnswerFailed
					asked={step.asked}
					detail={
						step.failure.kind === "signed_out"
							? "Sign-in is not set up in this app yet (issue #4)."
							: step.failure.message
					}
					onDone={done}
					onRetry={() =>
						void (request.kind === "text"
							? ask(request.text)
							: askByVoice(request.audio))
					}
					title={
						request.kind === "voice" && step.failure.kind === "unavailable"
							? "Talk is not available right now. You can type your question."
							: failureTitle[step.failure.kind]
					}
				/>
			);
		}
		default:
			return (
				<AskForm
					draft={step.draft}
					familyId={familyId}
					onAsk={(text) => void ask(text)}
					onTalk={() => void talk()}
					problem={step.problem}
					talkNote={talkNote}
				/>
			);
	}
}
