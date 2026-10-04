import { VoiceTranscript } from "@health/contracts/voice";
import { Button } from "@health/ui/components/button";
import { Mic, Square } from "lucide-react";
import { type Dispatch, type SetStateAction, useRef, useState } from "react";

import { apiRequest, familyPath } from "@/lib/api";

const VOICE_LABEL = {
	idle: "",
	recording: "Recording…",
	transcribing: "Working…",
} as const;

/**
 * The mic button and its live label. In Family mode it transcribes into the draft; with `askVoice`
 * (Gemini mode) the recording goes to Gemini as the question.
 */
export function VoiceButton({
	familyId,
	setText,
	setStatus,
	askVoice,
}: {
	familyId: string;
	setText: Dispatch<SetStateAction<string>>;
	setStatus: (status: string | null) => void;
	/** Gemini mode: sends the recording and returns a message to show, or null. */
	askVoice: ((audio: Blob) => Promise<string | null>) | null;
}) {
	const [voice, setVoice] = useState<keyof typeof VOICE_LABEL>("idle");
	const recorder = useRef<MediaRecorder | null>(null);

	const transcribe = async (audio: Blob) => {
		setVoice("transcribing");
		if (askVoice !== null) {
			setStatus(await askVoice(audio));
			setVoice("idle");
			return;
		}
		const result = await apiRequest(
			VoiceTranscript,
			familyPath(familyId, "/voice/transcriptions"),
			{ method: "POST", rawBody: { data: audio, type: audio.type } },
		);
		setVoice("idle");
		if (result.kind === "ready") {
			setText((current) =>
				current.trim() === ""
					? result.value.text
					: `${current} ${result.value.text}`,
			);
			setStatus(null);
			return;
		}
		console.error("Voice transcription failed:", result);
		setStatus(
			result.kind === "signed_out"
				? "Voice not available: sign in first."
				: `Voice not available: ${result.message}`,
		);
	};

	const toggleVoice = async () => {
		if (recorder.current !== null) {
			recorder.current.stop();
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const rec = new MediaRecorder(stream);
			const chunks: Blob[] = [];
			rec.ondataavailable = (event) => chunks.push(event.data);
			rec.onstop = () => {
				for (const track of stream.getTracks()) track.stop();
				recorder.current = null;
				const audio = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
				if (audio.size > 0) void transcribe(audio);
				else setVoice("idle");
			};
			recorder.current = rec;
			rec.start();
			setVoice("recording");
			setStatus(null);
		} catch (error) {
			console.error("Microphone not available:", error);
			setStatus("Voice not available: the microphone could not start.");
		}
	};

	const recording = voice === "recording";
	return (
		<>
			<Button
				type="button"
				aria-label={recording ? "Stop recording" : "Voice"}
				title={recording ? "Stop recording" : "Voice"}
				aria-pressed={recording}
				disabled={voice === "transcribing"}
				className="size-11 p-0"
				onClick={() => void toggleVoice()}
			>
				{recording ? <Square aria-hidden /> : <Mic aria-hidden />}
			</Button>
			<span className="grow text-[13px]" aria-live="polite">
				{VOICE_LABEL[voice]}
			</span>
		</>
	);
}
