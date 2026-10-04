import type { QuestionAttachment } from "@health/contracts/ask";
import type { VoiceTranscript } from "@health/contracts/voice";
import { Button } from "@health/ui/components/button";
import { Paperclip, Send, X } from "lucide-react";
import { type RefObject, useRef, useState } from "react";

import { Tip } from "@/components/win95";
import type { ApiResult } from "@/lib/api";
import type { Outcome } from "@/lib/pending";

import {
	ATTACHMENT_ACCEPT,
	type Attached,
	attachFiles,
	type ChatTarget,
	failureText,
	sendsToFamily,
	setFamilyOnly,
	toAttachment,
} from "./logic";
import { FileTray, X_BUTTON } from "./tray";
import { VoiceButton } from "./voice";

const FILES_TIP = "Files go only to the family agent";

/** Adds the words of a transcribed recording to the message box. Returns a message to show, or null. */
async function dictate(
	transcript: Promise<ApiResult<VoiceTranscript>>,
	setDraft: (update: (current: string) => string) => void,
	input: RefObject<HTMLTextAreaElement | null>,
): Promise<string | null> {
	const result = await transcript;
	if (result.kind !== "ready") {
		console.error("Recording not transcribed:", result);
		return `Voice not transcribed: ${failureText(result)}`;
	}
	const said = result.value.text.trim();
	if (said === "") return "No speech was heard.";
	setDraft((current) =>
		current.trim() === "" ? said : `${current.trimEnd()} ${said}`,
	);
	input.current?.focus();
	return null;
}

/** "Reply to <member>" with a × that ends the reply. The mode line above says it is family only. */
function ReplyLine({
	label,
	onCancel,
}: {
	label: string;
	onCancel: () => void;
}) {
	return (
		<p className="flex min-h-11 items-center gap-1 pl-2 font-bold text-[13px]">
			<span className="min-w-0 break-words">Reply to {label}</span>
			<Tip text={FILES_TIP} align="end" />
			<span className="grow" />
			<button
				type="button"
				aria-label="Cancel reply"
				title="Cancel reply"
				className={X_BUTTON}
				onClick={onCancel}
			>
				<X aria-hidden className="size-4" />
			</button>
		</p>
	);
}

/** The "Family only" toggle and where Send goes now, so the mode is never ambiguous. */
function ModeLine({
	toFamily,
	onToggle,
}: {
	toFamily: boolean;
	onToggle: (on: boolean) => void;
}) {
	return (
		<div className="flex min-h-11 flex-wrap items-center gap-x-3 pl-2 text-[13px]">
			<label className="flex min-h-11 items-center gap-2 font-bold">
				<input
					type="checkbox"
					checked={toFamily}
					aria-describedby="chat-mode"
					onChange={(event) => onToggle(event.currentTarget.checked)}
				/>
				Family only
			</label>
			<span id="chat-mode" className="min-w-0">
				{toFamily ? "To: family, not Gemini" : "To: family agent · Gemini"}
			</span>
		</div>
	);
}

/**
 * One recessed box: the "Family only" toggle, the message text, the attachment tray, and exactly
 * three buttons (attach, voice, send). With the toggle off, Send asks the family agent with the
 * attached files. With it on (or while replying), Send writes only to the family thread and the mic
 * fills the message box, so nothing reaches Gemini. The draft clears once sent.
 */
export function Composer({
	draft,
	setDraft,
	input,
	target,
	onTarget,
	placeholder,
	offline,
	agent,
	family,
}: {
	draft: string;
	setDraft: (update: (current: string) => string) => void;
	input: RefObject<HTMLTextAreaElement | null>;
	/** The "Family only" toggle and the family message being answered, if any. */
	target: ChatTarget;
	onTarget: (update: (current: ChatTarget) => ChatTarget) => void;
	placeholder: string;
	/** The server is down: Send is disabled so the outage banner holds the one primary action. */
	offline: boolean;
	agent: {
		/** Resolves true once the family agent answered. */
		ask: (
			question: string,
			attachments: readonly QuestionAttachment[],
		) => Promise<boolean>;
		/** Returns a message to show, or null. */
		askVoice: (audio: Blob) => Promise<string | null>;
	};
	family: {
		/** Stores the message, or saves it on this device to send once later. */
		send: (body: string) => Promise<Outcome>;
		transcribe: (audio: Blob) => Promise<ApiResult<VoiceTranscript>>;
	};
}) {
	const [sending, setSending] = useState(false);
	const [files, setFiles] = useState<Attached[]>([]);
	const [status, setStatus] = useState<string | null>(null);
	const picker = useRef<HTMLInputElement>(null);
	const toFamily = sendsToFamily(target);
	const endReply = () => onTarget((current) => ({ ...current, replyTo: null }));

	const addFiles = (picked: FileList | null) => {
		const next = attachFiles(files, picked ?? []);
		for (const entry of next.slice(files.length))
			if (entry.error !== null)
				console.error(`Attachment ${entry.file.name} rejected:`, entry.error);
		setFiles(next);
	};

	const askAgent = async (question: string) => {
		const sent = files.filter((entry) => entry.error === null);
		let attachments: QuestionAttachment[];
		try {
			attachments = await Promise.all(
				sent.map((entry) => toAttachment(entry.file)),
			);
		} catch (error) {
			console.error("An attached file could not be read:", error);
			setStatus(`Not sent: a file could not be read. ${error}`);
			return false;
		}
		if (!(await agent.ask(question, attachments))) return false;
		setFiles((current) => current.filter((entry) => !sent.includes(entry)));
		return true;
	};

	const sendFamily = async (body: string) => {
		const outcome = await family.send(body);
		if (outcome.kind === "rejected") {
			setStatus(`Not sent: ${outcome.message}`);
			return false;
		}
		if (outcome.kind === "waiting")
			setStatus(
				"Saved on this device. It will be sent once, when the connection returns.",
			);
		endReply();
		return true;
	};

	const submit = async () => {
		const body = draft.trim();
		if (body === "") {
			setStatus(
				toFamily ? "Write a message first." : "Write a question first.",
			);
			return;
		}
		setStatus(null);
		setSending(true);
		const sent = await (toFamily ? sendFamily(body) : askAgent(body));
		setSending(false);
		if (sent) setDraft((current) => (current.trim() === body ? "" : current));
	};

	return (
		<form
			className="win95-inset grid gap-1 bg-white p-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape" && target.replyTo !== null) endReply();
			}}
		>
			<FileTray
				files={files}
				onRemove={(id) =>
					setFiles((current) => current.filter((entry) => entry.id !== id))
				}
			/>
			<input
				ref={picker}
				type="file"
				multiple
				hidden
				accept={ATTACHMENT_ACCEPT}
				onChange={(event) => {
					addFiles(event.currentTarget.files);
					event.currentTarget.value = "";
				}}
			/>
			<ModeLine
				toFamily={toFamily}
				onToggle={(on) => onTarget((current) => setFamilyOnly(current, on))}
			/>
			{target.replyTo !== null && (
				<ReplyLine label={target.replyTo} onCancel={endReply} />
			)}
			<label htmlFor="chat-message" className="sr-only">
				Message
			</label>
			<textarea
				ref={input}
				id="chat-message"
				rows={3}
				value={draft}
				placeholder={toFamily ? "Write to the family…" : placeholder}
				onChange={(event) => {
					const value = event.currentTarget.value;
					setDraft(() => value);
				}}
				className="h-[78px] w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 text-[15px] leading-[1.4] focus-visible:outline-dotted focus-visible:outline-2 focus-visible:outline-black focus-visible:-outline-offset-2"
			/>
			{status !== null && (
				<p role="status" className="win95-inset px-2 py-1 text-[13px]">
					{status}
				</p>
			)}
			<ComposerBar
				toFamily={toFamily}
				disabled={offline || sending}
				offline={offline}
				onAttach={() => picker.current?.click()}
				setStatus={setStatus}
				onRecording={
					toFamily
						? (audio) => dictate(family.transcribe(audio), setDraft, input)
						: agent.askVoice
				}
			/>
		</form>
	);
}

/** Exactly three buttons: attach (off when Send goes to the family), voice, and send. */
function ComposerBar({
	toFamily,
	disabled,
	offline,
	onAttach,
	setStatus,
	onRecording,
}: {
	toFamily: boolean;
	/** Send is off while the server is down or a send is in progress. */
	disabled: boolean;
	offline: boolean;
	onAttach: () => void;
	setStatus: (status: string | null) => void;
	onRecording: (audio: Blob) => Promise<string | null>;
}) {
	return (
		<div className="flex items-center gap-1">
			<Button
				type="button"
				aria-label="Attach files"
				title={toFamily ? FILES_TIP : "Attach files"}
				disabled={toFamily}
				className="size-11 p-0"
				onClick={onAttach}
			>
				<Paperclip aria-hidden />
			</Button>
			<VoiceButton setStatus={setStatus} onRecording={onRecording} />
			<Button
				type="submit"
				disabled={disabled}
				className={offline ? "h-11 px-4" : "win95-primary h-11 px-4"}
			>
				<Send aria-hidden />
				Send
			</Button>
		</div>
	);
}
