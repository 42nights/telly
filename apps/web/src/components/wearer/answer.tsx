import type { FamilyAnswer } from "@health/contracts/ask";
import { Button } from "@health/ui/components/button";
import { CloudOff, Mic, RotateCw, Snail, Square, Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";

import { useDemoWarning } from "@/lib/demo";

import { evidenceLine } from "./logic";
import { SpeechLine, useSpeech } from "./speech";
import { useNow } from "./use-now";

export const xl = "h-16 w-full text-[22px] [&_svg]:size-7";

export type Reply = {
	readonly id: string;
	readonly asked: string;
	readonly answer: FamilyAnswer;
	/** Base64 MP3 that came with a voice answer. */
	readonly audio: string | null;
	/** The language heard in a spoken request; the answer is spoken in it. Null for typed text. */
	readonly languageCode: string | null;
	/** Why a voice answer came without audio. */
	readonly voiceNote: string | null;
};

function AskAgain({ onDone }: { onDone: () => void }) {
	return (
		<Button autoFocus className={`win95-primary ${xl}`} onClick={onDone}>
			<Mic aria-hidden />
			Ask something else
		</Button>
	);
}

function Asked({
	asked,
	languageCode = null,
}: {
	asked: string;
	languageCode?: string | null;
}) {
	return (
		<>
			<p className="text-[16px] text-muted-foreground">
				{languageCode === null
					? "You asked"
					: // "Spanish" for `es`; the code itself when the browser has no name for it.
						`You said (heard in ${new Intl.DisplayNames(undefined, { type: "language" }).of(languageCode) ?? languageCode})`}
			</p>
			<p
				className="break-words font-bold text-[22px]"
				lang={languageCode ?? undefined}
			>
				“{asked}”
			</p>
		</>
	);
}

/** Where the answer came from, briefly: up to three records, and what had no records. */
function Sources({ answer }: { answer: FamilyAnswer }) {
	const now = useNow();
	useDemoWarning(answer.evidence, "The answer cites");
	if (answer.evidence.length === 0 && answer.unavailable.length === 0)
		return null;
	return (
		<ul className="grid gap-1 text-[16px] text-muted-foreground">
			{answer.evidence.slice(0, 3).map((sample) => (
				<li key={sample.id}>{evidenceLine(sample, now)}</li>
			))}
			{answer.unavailable.length > 0 && (
				<li>
					No records for:{" "}
					{answer.unavailable.map((m) => m.replaceAll("_", " ")).join(", ")}
				</li>
			)}
		</ul>
	);
}

/**
 * Gemini's answer in large text, its sources, and its voice: the MP3 it came with, or speech in the
 * request's language. It is spoken once on arrival; Stop, Say it again, and Slower control it.
 */
export function AnswerPanel({
	reply,
	familyId,
	onDone,
}: {
	reply: Reply;
	familyId: string | null;
	onDone: () => void;
}) {
	const { speech, say, stop } = useSpeech(familyId);
	const speak = (slow = false) =>
		void say(reply.id, reply.answer.answer, {
			mp3Base64: reply.audio ?? undefined,
			languageCode: reply.languageCode ?? undefined,
			slow,
		});
	const played = useRef(false);
	useEffect(() => {
		if (played.current) return;
		played.current = true;
		speak();
	});
	const said = speech.key === reply.id;
	const busy = speech.kind === "loading" || speech.kind === "speaking";
	const control = "h-14 w-full text-[20px] [&_svg]:size-6";
	return (
		<div aria-live="polite" className="grid gap-3">
			<Asked asked={reply.asked} languageCode={reply.languageCode} />
			<div className="win95-inset grid gap-3 bg-white p-4 text-black">
				<p
					className="whitespace-pre-wrap break-words text-[24px] leading-snug"
					lang={reply.languageCode ?? undefined}
				>
					{reply.answer.answer}
				</p>
				<Sources answer={reply.answer} />
			</div>
			{reply.voiceNote !== null && (
				<p className="text-[16px]">{reply.voiceNote}</p>
			)}
			{busy ? (
				<Button className={control} onClick={stop} variant="outline">
					<Square aria-hidden />
					Stop
				</Button>
			) : (
				<div className="grid grid-cols-2 gap-2">
					<Button className={control} onClick={() => speak()} variant="outline">
						<Volume2 aria-hidden />
						{said ? "Say it again" : "Read it aloud"}
					</Button>
					<Button
						className={control}
						onClick={() => speak(true)}
						variant="outline"
					>
						<Snail aria-hidden />
						Slower
					</Button>
				</div>
			)}
			{said && <SpeechLine speech={speech} />}
			<AskAgain onDone={onDone} />
		</div>
	);
}

/** No answer: Gemini, sign-in, or the network failed. Never an invented answer. */
export function AnswerFailed({
	asked,
	title,
	detail,
	onRetry,
	onDone,
}: {
	asked: string | null;
	title: string;
	detail: string;
	/** Sends the same request again: the typed text, or the kept recording. */
	onRetry: () => void;
	onDone: () => void;
}) {
	return (
		<div className="grid gap-3">
			{asked !== null && <Asked asked={asked} />}
			<div
				className="win95-raised grid grid-cols-[auto_1fr] gap-3 p-4"
				role="alert"
			>
				<CloudOff aria-hidden className="size-7 text-destructive" />
				<div className="grid gap-1">
					<p className="font-semibold text-[22px]">I can't answer right now.</p>
					<p className="text-[18px]">{title}</p>
					<p className="break-words text-[15px] text-muted-foreground">
						{detail}
					</p>
				</div>
			</div>
			<Button className={`win95-primary ${xl}`} onClick={onRetry}>
				<RotateCw aria-hidden />
				Try again
			</Button>
			<AskAgain onDone={onDone} />
		</div>
	);
}
