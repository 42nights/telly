import type { FamilyMessage } from "@health/contracts";
import { Button } from "@health/ui/components/button";
import { Reply, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { Tip } from "@/components/win95";
import { memberLabel } from "@/lib/members";

import { type Ask, evidenceLine, type TimelineItem } from "./logic";

const formatTime = (iso: string) =>
	new Date(iso).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});

function Entry({
	who,
	meta,
	children,
	className = "",
}: {
	who: ReactNode;
	meta: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<li className={`grid gap-0.5 ${className}`}>
			<p className="flex items-center justify-between gap-2 font-bold text-[13px]">
				{who}
				{meta}
			</p>
			{children}
		</li>
	);
}

const BODY = "whitespace-pre-wrap break-words text-[15px]";

/** A family message. `onReply` is set only for a message another member wrote. */
function MessageItem({
	message,
	label,
	onReply,
}: {
	message: FamilyMessage;
	label: string;
	onReply: (() => void) | null;
}) {
	return (
		<Entry
			who={<span title={message.sender}>{label}</span>}
			meta={
				<time dateTime={message.sentAt} className="font-normal">
					{formatTime(message.sentAt)}
				</time>
			}
		>
			<p className={BODY}>{message.body}</p>
			{onReply !== null && (
				<Button
					type="button"
					variant="outline"
					aria-label={`Reply to ${label}`}
					className="h-11 justify-self-start px-3 text-[13px]"
					onClick={onReply}
				>
					<Reply aria-hidden />
					Reply
				</Button>
			)}
		</Entry>
	);
}

const FOLLOW_UP_TIP =
	"Gemini suggests follow-ups from this answer. Tap one to put it in the message box; nothing is sent until you press Send.";

/** The follow-up questions Gemini made from one answer. Tapping one fills the message box. */
function FollowUps({
	questions,
	onPick,
}: {
	questions: readonly string[];
	onPick: (question: string) => void;
}) {
	if (questions.length === 0) return null;
	return (
		<div className="mt-1.5 grid gap-1.5 border-[#808080] border-t border-dotted pt-1.5">
			<p className="flex items-center gap-1 text-[#3c3c3c] text-[12px]">
				Suggested by the family agent
				<Tip text={FOLLOW_UP_TIP} />
			</p>
			{questions.map((question) => (
				<button
					key={question}
					type="button"
					className="min-h-11 justify-self-start border border-[#000080] border-dashed bg-white px-3 py-1 text-left text-[#000080] text-[14px] hover:bg-[#eef0ff] focus-visible:outline-dotted focus-visible:outline-2 focus-visible:outline-black focus-visible:outline-offset-2"
					onClick={() => onPick(question)}
				>
					{question}
				</button>
			))}
		</div>
	);
}

/** Your question to the family agent, then its answer with the cited records (or why there is none). */
function AskItem({
	ask,
	onFollowUp,
}: {
	ask: Ask;
	onFollowUp: (question: string) => void;
}) {
	const { state } = ask;
	return (
		<>
			<Entry
				who={<span>You → family agent</span>}
				meta={
					<time dateTime={ask.askedAt} className="font-normal">
						{formatTime(ask.askedAt)}
					</time>
				}
			>
				<p className={BODY}>{ask.question}</p>
				{ask.files.length > 0 && (
					<p className="break-words text-[13px]">
						Attached: {ask.files.join(", ")}
					</p>
				)}
			</Entry>
			<Entry
				className="win95-inset bg-[#ffffe1] p-2"
				who={
					<span className="flex flex-wrap items-center gap-x-1">
						<Sparkles aria-hidden className="size-4" />
						Family agent · Gemini
						{state.kind === "answered" && (
							<small className="font-normal">({state.answer.model})</small>
						)}
					</span>
				}
				meta={
					state.kind === "answered" ? (
						<time dateTime={state.answer.answeredAt} className="font-normal">
							{formatTime(state.answer.answeredAt)}
						</time>
					) : state.kind === "pending" ? (
						<span className="font-normal">working…</span>
					) : (
						<span className="text-destructive">Not answered</span>
					)
				}
			>
				{state.kind === "answered" ? (
					<>
						<p className={BODY}>{state.answer.answer}</p>
						<Sources answer={state.answer} />
						<FollowUps questions={state.answer.followUps} onPick={onFollowUp} />
					</>
				) : state.kind === "pending" ? (
					<p className="text-[13px]">Checking the family's records…</p>
				) : (
					<p className="break-words text-[13px]">{state.message}</p>
				)}
			</Entry>
		</>
	);
}

function Sources({
	answer,
}: {
	answer: Extract<Ask["state"], { kind: "answered" }>["answer"];
}) {
	if (answer.evidence.length === 0 && answer.unavailable.length === 0)
		return null;
	return (
		<ul aria-label="Sources" className="grid gap-0.5 text-[13px]">
			{answer.evidence.map((evidence) => (
				<li key={evidence.id} className="break-words">
					{evidenceLine(evidence, formatTime)}
				</li>
			))}
			{answer.unavailable.map((metric) => (
				<li key={metric} className="break-words">
					No records: {metric}
				</li>
			))}
		</ul>
	);
}

/** The fixed-height message log; column-reverse keeps the scroll at the newest entry. */
export function ChatLog({
	items,
	identity,
	emptyText,
	onReply,
	onFollowUp,
}: {
	items: readonly TimelineItem[];
	identity: string | null;
	emptyText: string;
	/** Starts a family reply to the member with this label. */
	onReply: (label: string) => void;
	onFollowUp: (question: string) => void;
}) {
	const messageItem = (message: FamilyMessage) => {
		const label = memberLabel(message.sender, identity);
		const other = identity !== null && message.sender !== identity;
		return (
			<MessageItem
				key={message.id}
				message={message}
				label={label}
				onReply={other ? () => onReply(label) : null}
			/>
		);
	};
	return (
		<div
			role="log"
			aria-label="Messages"
			className="win95-inset flex h-[340px] flex-col-reverse overflow-y-auto bg-white p-2"
		>
			{items.length === 0 ? (
				<p className="text-[13px]">{emptyText}</p>
			) : (
				<ol className="grid gap-3.5">
					{items.map((item) =>
						item.kind === "message" ? (
							messageItem(item.message)
						) : (
							<AskItem
								key={item.ask.id}
								ask={item.ask}
								onFollowUp={onFollowUp}
							/>
						),
					)}
				</ol>
			)}
		</div>
	);
}
