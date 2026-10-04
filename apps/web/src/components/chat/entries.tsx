import type { FamilyMessage } from "@health/contracts";
import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

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

function MessageItem({
	message,
	identity,
}: {
	message: FamilyMessage;
	identity: string | null;
}) {
	return (
		<Entry
			who={
				<span title={message.sender}>
					{memberLabel(message.sender, identity)}
				</span>
			}
			meta={
				<time dateTime={message.sentAt} className="font-normal">
					{formatTime(message.sentAt)}
				</time>
			}
		>
			<p className={BODY}>{message.body}</p>
		</Entry>
	);
}

/** Your question to the family agent, then its answer with the cited records (or why there is none). */
function AskItem({ ask }: { ask: Ask }) {
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
}: {
	items: readonly TimelineItem[];
	identity: string | null;
	emptyText: string;
}) {
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
							<MessageItem
								key={item.message.id}
								message={item.message}
								identity={identity}
							/>
						) : (
							<AskItem key={item.ask.id} ask={item.ask} />
						),
					)}
				</ol>
			)}
		</div>
	);
}
