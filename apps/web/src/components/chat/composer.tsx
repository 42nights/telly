import { Button } from "@health/ui/components/button";
import { Paperclip, Send } from "lucide-react";
import { useRef, useState } from "react";

import { acceptFiles } from "./logic";
import { type Attached, FileTray } from "./tray";
import { VoiceButton } from "./voice";

const NO_UPLOAD = "Files can't be sent yet: there is no upload route.";

/**
 * One recessed box: the question text, the attachment tray, and exactly three buttons (attach,
 * voice, send). `onSend` asks the family agent; the draft clears once it answered.
 * There is no upload route, so files are never sent and stay in the tray.
 */
export function Composer({
	placeholder,
	offline,
	onSend,
	askVoice,
}: {
	placeholder: string;
	/** The server is down: Send is disabled so the outage banner holds the one primary action. */
	offline: boolean;
	/** Resolves true once the family agent answered. */
	onSend: (body: string) => Promise<boolean>;
	askVoice: (audio: Blob) => Promise<string | null>;
}) {
	const [text, setText] = useState("");
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
			setStatus(files.length > 0 ? NO_UPLOAD : "Write a question first.");
			return;
		}
		setSending(true);
		const answered = await onSend(body);
		setSending(false);
		if (answered)
			setText((current) => (current.trim() === body ? "" : current));
		setStatus(
			answered && files.length > 0
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
				<VoiceButton setStatus={setStatus} askVoice={askVoice} />
				<Button
					type="submit"
					disabled={offline || sending}
					className={offline ? "h-11 px-4" : "win95-primary h-11 px-4"}
				>
					<Send aria-hidden />
					Send
				</Button>
			</div>
		</form>
	);
}
