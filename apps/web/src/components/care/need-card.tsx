// One care need: what it is, who was contacted and how each attempt stands, and the answers the
// caller may send. Transport states (sent, delivered, answered) never read as handled.
import type { CareNeed, CareResponse } from "@health/contracts/care";
import { Button } from "@health/ui/components/button";

import { actionsFor, attemptLabel, kindLabel, needStatusLabel } from "./logic";

const actionLabel: Record<CareResponse["response"], string> = {
	seen: "Mark seen",
	answer: "Answer call",
	accept: "I'll take it",
	decline: "I can't",
	help_confirmed: "Help confirmed",
};

const time = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		dateStyle: "short",
		timeStyle: "short",
	});

export function NeedCard({
	need,
	me,
	busy,
	onRespond,
}: {
	need: CareNeed;
	me: string | null;
	busy: boolean;
	onRespond: (response: CareResponse["response"]) => void;
}) {
	const actions = actionsFor(need, me);
	const closed = need.status === "resolved";
	return (
		<article
			aria-label={`${kindLabel[need.kind]}: ${needStatusLabel[need.status]}`}
			className="win95-inset grid gap-2 bg-card p-2"
		>
			<header className="flex flex-wrap items-baseline justify-between gap-2">
				<h4 className="font-bold">{kindLabel[need.kind]}</h4>
				<span
					className={closed ? "text-sm" : "font-bold text-destructive text-sm"}
				>
					{needStatusLabel[need.status]}
				</span>
			</header>
			<p className="break-words">{need.summary}</p>
			{need.facts.length > 0 && (
				<ul className="grid gap-1 text-xs">
					{need.facts.map((fact) => (
						<li key={`${fact.source}-${fact.observedAt}-${fact.text}`}>
							{fact.text} · {fact.source} · {time(fact.observedAt)} ·{" "}
							{fact.uncertainty}
						</li>
					))}
				</ul>
			)}
			<ol className="grid gap-1 text-xs" aria-label="Contact attempts">
				{need.attempts.map((attempt) => (
					<li key={attempt.step} className="flex flex-wrap gap-x-2">
						<span className="font-bold">
							{attempt.name}
							{attempt.backup ? " (backup)" : ""}
						</span>
						<span>
							{attempt.channel === "call" ? "Simulated call" : "Message"}
						</span>
						<span>{attemptLabel[attempt.status]}</span>
						<span>their time {attempt.contactLocalTime}</span>
					</li>
				))}
				{need.remaining.map((name) => (
					<li key={name} className="text-muted-foreground">
						{name}: not contacted yet
					</li>
				))}
			</ol>
			{need.status === "accepted" && need.followUpBy !== null && (
				<p className="text-xs">
					If help is not confirmed by {time(need.followUpBy)}, Telly asks the
					next contact.
				</p>
			)}
			{actions.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{actions.map((action) => (
						<Button
							key={action}
							className="h-11"
							disabled={busy}
							onClick={() => onRespond(action)}
						>
							{actionLabel[action]}
						</Button>
					))}
				</div>
			)}
		</article>
	);
}
