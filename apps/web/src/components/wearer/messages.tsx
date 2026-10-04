import type { FamilyRecords } from "@health/contracts";
import { Me } from "@health/contracts/families";
import { Button, buttonVariants } from "@health/ui/components/button";
import { Link } from "@tanstack/react-router";
import { MessageSquare, Volume2 } from "lucide-react";

import { ApiNotice } from "@/components/win95";
import { type ApiState, useApi } from "@/lib/api";
import { memberLabel } from "@/lib/members";

import { SpeechLine, useSpeech } from "./speech";

const time = (iso: string) =>
	new Date(iso).toLocaleString([], {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});

/** The family's messages, newest first, read-only. Each one can be read aloud. */
export function Messages({
	records,
	familyId,
}: {
	records: ApiState<FamilyRecords>;
	familyId: string | null;
}) {
	const { speech, say } = useSpeech(familyId);
	const meState = useApi(Me, "/api/me");
	const me = meState.kind === "ready" ? meState.value.identity : null;
	if (records.kind !== "ready")
		return (
			<div className="win95-inset bg-card">
				<ApiNotice state={records} what="messages" />
			</div>
		);
	const messages = records.value.messages
		.filter((message) => message.familyId === familyId)
		.toSorted((a, b) => b.sentAt.localeCompare(a.sentAt));
	return (
		<div className="grid gap-2">
			<Link
				className={buttonVariants({
					variant: "outline",
					className: "h-12 justify-self-start text-[18px] [&_svg]:size-5",
				})}
				data-slot="button"
				to="/chat"
			>
				<MessageSquare aria-hidden />
				Open family chat
			</Link>
			<ul className="win95-inset grid max-h-[28rem] content-start gap-2 overflow-y-auto bg-card p-2">
				{messages.length === 0 && (
					<li className="p-2 text-[18px]">No messages yet.</li>
				)}
				{messages.map((message) => {
					const said = speech.key === message.id;
					return (
						<li
							className="win95-inset grid gap-2 bg-white px-3 py-2"
							key={message.id}
						>
							<p className="flex justify-between gap-2 border-[#808080] border-b pb-1 font-bold text-[#000080] text-[15px]">
								<span className="min-w-0 break-words">
									{memberLabel(message.sender, me)}
								</span>
								<time dateTime={message.sentAt}>{time(message.sentAt)}</time>
							</p>
							<p className="whitespace-pre-wrap break-words text-[20px] text-black">
								{message.body}
							</p>
							<div className="flex flex-wrap items-center gap-2">
								<Button
									className="h-11 px-3 text-[18px]"
									disabled={said && speech.kind === "loading"}
									onClick={() => void say(message.id, message.body)}
									variant="outline"
								>
									<Volume2 aria-hidden className="size-5" />
									{said ? "Say it again" : "Listen"}
								</Button>
								{said && <SpeechLine speech={speech} />}
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
