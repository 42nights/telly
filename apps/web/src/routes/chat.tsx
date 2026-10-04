import { Me } from "@health/contracts/families";
import { Button, buttonVariants } from "@health/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CloudOff, MessagesSquare, RotateCw } from "lucide-react";
import { type ReactNode, useState } from "react";

import { type ChatMode, Composer } from "@/components/chat/composer";
import { ChatLog } from "@/components/chat/entries";
import {
	GEMINI_CHIP,
	type GeminiStatus,
	timeline,
} from "@/components/chat/logic";
import { useAsk } from "@/components/chat/use-ask";
import { useChat } from "@/components/chat/use-chat";
import { Window } from "@/components/hud/window";
import { ApiNotice, SUPPORT_MAILTO, Tip } from "@/components/win95";
import { type ApiFailure, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

export const Route = createFileRoute("/chat")({ component: ChatRoute });

function ChatRoute() {
	const { state, family } = useFamily();
	const me = useApi(Me, "/api/me");
	const identity = me.kind === "ready" ? me.value.identity : null;

	let body: ReactNode;
	if (state.kind !== "ready")
		body = (
			<>
				<ChatHeader familyName={null} gemini={{ kind: "unknown" }} />
				<ApiNotice state={state} what="family" />
			</>
		);
	else if (family === null)
		body = (
			<>
				<ChatHeader familyName={null} gemini={{ kind: "unknown" }} />
				<p className="win95-inset p-3 text-[13px]">
					You are not in a family yet. A family is paired manually for now.
				</p>
			</>
		);
	else
		body = (
			<ChatBody
				key={family.id}
				familyId={family.id}
				familyName={family.name}
				identity={identity}
			/>
		);

	return (
		<main className="win95-desktop min-h-full p-2 sm:p-6">
			<Window
				title={`Family chat${family === null ? "" : ` · ${family.name}`}`}
				icon={MessagesSquare}
				className="mx-auto w-full max-w-2xl"
			>
				{body}
			</Window>
		</main>
	);
}

function ChatHeader({
	familyName,
	gemini,
}: {
	familyName: string | null;
	gemini: GeminiStatus;
}) {
	return (
		<div className="mb-2 flex items-center gap-1">
			<Link
				to="/family"
				className={buttonVariants({
					variant: "ghost",
					className: "h-11 text-[13px]",
				})}
			>
				<ArrowLeft aria-hidden />
				Family
			</Link>
			<span className="grow" />
			<span
				className={`win95-inset px-2 py-1 text-[13px] ${gemini.kind === "unavailable" ? "font-bold text-destructive" : ""}`}
			>
				{GEMINI_CHIP[gemini.kind]}
			</span>
			<Tip
				text={
					gemini.kind === "unavailable"
						? `Gemini is unavailable: ${gemini.message}`
						: "Gemini answers questions from the family's records and cites them. Its answers stay on this device for this session only; there is no answer history yet."
				}
			/>
			<Tip
				text={`In this chat: the members of ${familyName ?? "your family"}. Choose To: Gemini to ask about the records.`}
			/>
		</div>
	);
}

function ChatBody({
	familyId,
	familyName,
	identity,
}: {
	familyId: string;
	familyName: string;
	identity: string | null;
}) {
	const { messages, read, outbox, send, retryRead } = useChat(familyId);
	const { asks, status, ask, askVoice } = useAsk(familyId);
	const [text, setText] = useState("");
	const [mode, setMode] = useState<ChatMode>("family");
	/** Sends `body` in `via`, and clears the draft when it still holds that text. */
	const submit = async (body: string, via: ChatMode = mode) => {
		const done = await (via === "gemini" ? ask(body) : send(body));
		if (done) setText((current) => (current.trim() === body ? "" : current));
		return done;
	};
	const header = <ChatHeader familyName={familyName} gemini={status} />;
	if (read.kind === "signed_out" || read.kind === "forbidden")
		return (
			<>
				{header}
				<ApiNotice state={read} what="family messages" />
			</>
		);
	const down = read.kind === "error" || read.kind === "unavailable";
	const emptyText =
		read.kind === "loading"
			? "Loading messages…"
			: down
				? "Messages could not be loaded."
				: "No family messages yet.";
	return (
		<div className="grid gap-2">
			{header}
			<ChatLog
				items={timeline(messages, asks)}
				outbox={outbox}
				identity={identity}
				emptyText={emptyText}
				onRetry={(body) => void submit(body, "family")}
			/>
			{down && <Outage failure={read} onRetry={retryRead} />}
			<Composer
				familyId={familyId}
				placeholder={
					mode === "gemini"
						? `Ask Gemini about ${familyName}'s records…`
						: `Message ${familyName}'s family…`
				}
				offline={down}
				onSend={submit}
				text={text}
				setText={setText}
				mode={mode}
				setMode={setMode}
				askVoice={askVoice}
			/>
		</div>
	);
}

function Outage({
	failure,
	onRetry,
}: {
	failure: Extract<ApiFailure, { kind: "error" | "unavailable" }>;
	onRetry: () => void;
}) {
	return (
		<div
			role="alert"
			className="win95-inset flex flex-wrap items-start gap-2 p-2 text-[13px]"
		>
			<CloudOff aria-hidden className="size-5 shrink-0 text-destructive" />
			<div className="grid min-w-0 flex-1 gap-1">
				<p className="font-bold">
					{failure.kind === "error"
						? "The server is not reachable."
						: "The server is not available."}
				</p>
				<p className="break-words">
					New family messages cannot load. Alerts use a separate path.{" "}
					{failure.message}
				</p>
			</div>
			<div className="grid basis-full grid-cols-2 gap-2">
				<Button type="button" className="win95-primary h-11" onClick={onRetry}>
					<RotateCw aria-hidden />
					Try again
				</Button>
				<a
					href={SUPPORT_MAILTO}
					className={buttonVariants({ variant: "outline", className: "h-11" })}
				>
					Contact support
				</a>
			</div>
		</div>
	);
}
