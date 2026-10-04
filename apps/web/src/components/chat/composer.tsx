import { Button } from "@health/ui/components/button";
import { Paperclip, Send } from "lucide-react";
import { type Dispatch, type SetStateAction, useRef, useState } from "react";

import { acceptFiles } from "./logic";
import { type Attached, FileTray } from "./tray";
import { VoiceButton } from "./voice";

const NO_UPLOAD = "Files can't be sent yet: there is no upload route.";

export type ChatMode = "family" | "gemini";

/**
 * One recessed box: a To control (Family or Gemini), message text, the attachment tray, and
 * exactly three buttons (attach, voice, send). `onSend` sends in the current mode and the parent
 * clears the draft once it is stored or answered. There is no upload route, so files are never
 * sent and stay in the tray.
 */
export function Composer({
	familyId,
	placeholder,
	offline,
	onSend,
	text,
	setText,
	mode,
	setMode,
	askVoice,
}: {
	familyId: string;
	placeholder: string;
	/** The server is down: Send is disabled so the outage banner holds the one primary action. */
	offline: boolean;
	/** Resolves true once the server stored the message or Gemini answered. */
	onSend: (body: string) => Promise<boolean>;
	/** The draft. The parent owns it so a retry from the list can clear it too. */
	text: string;
	setText: Dispatch<SetStateAction<string>>;
	mode: ChatMode;
	setMode: (mode: ChatMode) => void;
	askVoice: (audio: Blob) => Promise<string | null>;
}) {
	const [sending, setSending] = useState(false);
	const [files, setFiles] = useState<Attached[]>([]);
	const [status, setStatus] = useState<string | null>(null);
	const picker = useRef<HTMLInputElement>(null);

	const addFiles = (list: FileList | null) => {
		const { accepted, rejected } = acceptFiles(list ?? []);
		if (rejected.length > 0)
			console.error("Rejected attachments without file data:", rejected);
		setFiles((current) => [
			...current,
			...accepted.map((file) => ({ id: crypto.randomUUID(), file })),
		]);
	};

	const submit = async () => {
		const body = text.trim();
		if (body === "") {
			setStatus(files.length > 0 ? NO_UPLOAD : "Write a message first.");
			return;
		}
		setSending(true);
		const stored = await onSend(body);
		setSending(false);
		setStatus(
			stored && files.length > 0
				? "Files can't be sent yet; only the text was sent."
				: null,
		);
	};

	return (
		<form
			className="win95-inset grid gap-1 bg-white p-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
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
				onChange={(event) => {
					addFiles(event.currentTarget.files);
					event.currentTarget.value = "";
				}}
			/>
			<fieldset className="flex items-center gap-1 text-[13px]">
				<legend className="sr-only">Send to</legend>
				<span aria-hidden className="px-1 font-bold">
					To:
				</span>
				{(["family", "gemini"] as const).map((option) => (
					<label
						key={option}
						className="flex h-11 cursor-pointer items-center gap-1.5 px-2 has-[:checked]:font-bold has-[:focus-visible]:outline-dotted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-black"
					>
						<input
							type="radio"
							className="size-4 accent-[#000080] [color-scheme:light]"
							name="chat-mode"
							checked={mode === option}
							onChange={() => setMode(option)}
						/>
						{option === "family" ? "Family" : "Gemini"}
					</label>
				))}
			</fieldset>
			<label htmlFor="chat-message" className="sr-only">
				Message
			</label>
			<textarea
				id="chat-message"
				rows={3}
				value={text}
				placeholder={placeholder}
				onChange={(event) => setText(event.currentTarget.value)}
				className="h-[78px] w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 text-[15px] leading-[1.4] focus-visible:outline-dotted focus-visible:outline-2 focus-visible:outline-black focus-visible:-outline-offset-2"
			/>
			{status !== null && (
				<p role="status" className="win95-inset px-2 py-1 text-[13px]">
					{status}
				</p>
			)}
			<div className="flex items-center gap-1">
				<Button
					type="button"
					aria-label="Attach files"
					title="Attach files"
					className="size-11 p-0"
					onClick={() => picker.current?.click()}
				>
					<Paperclip aria-hidden />
				</Button>
				<VoiceButton
					familyId={familyId}
					setText={setText}
					setStatus={setStatus}
					askVoice={mode === "gemini" ? askVoice : null}
				/>
				<Button
					type="submit"
					disabled={offline || sending}
					className={offline ? "h-11 px-4" : "win95-primary h-11 px-4"}
				>
					<Send aria-hidden />
					{mode === "gemini" ? "Ask" : "Send"}
				</Button>
			</div>
		</form>
	);
}
