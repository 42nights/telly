import { Button } from "@health/ui/components/button";
import { Mic, Square } from "lucide-react";
import { useRef, useState } from "react";

const VOICE_LABEL = {
	idle: "",
	recording: "Recording…",
	transcribing: "Working…",
} as const;

/** The mic button and its live label. The recording goes to the family agent as the question. */
export function VoiceButton({
	setStatus,
	askVoice,
}: {
	setStatus: (status: string | null) => void;
	/** Sends the recording and returns a message to show, or null. */
	askVoice: (audio: Blob) => Promise<string | null>;
}) {
	const [voice, setVoice] = useState<keyof typeof VOICE_LABEL>("idle");
	const recorder = useRef<MediaRecorder | null>(null);

	const transcribe = async (audio: Blob) => {
		setVoice("transcribing");
		setStatus(await askVoice(audio));
		setVoice("idle");
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
