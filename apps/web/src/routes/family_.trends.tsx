// Health trends (docs/board.html#db-hrv, #ph-chat): a question answered from dated records. Each kind
// of evidence shows in its own group; source, period, count, and sync age sit in each row's
// tooltip. Missing and conflicting data stay visible, and the only next steps are a check-in or a
// review.
import { Me } from "@health/contracts/families";
import {
	type EvidenceKind,
	TrendExplanation,
	type TrendObservation,
} from "@health/contracts/trends";
import { Button } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { TrendingUp } from "lucide-react";
import { type FormEvent, useState } from "react";

import { ago } from "@/components/family/logic";
import { Window } from "@/components/hud/window";
import { ApiNotice, Hint } from "@/components/win95";
import { type ApiResult, apiRequest, familyPath, useApi } from "@/lib/api";
import { PersonPicker, useFamily } from "@/lib/family";
import { memberLabel } from "@/lib/members";
import { metricLabel, readingValue, sourceName } from "@/lib/readings";

export const Route = createFileRoute("/family_/trends")({ component: Trends });

const groups: ReadonlyArray<{ kind: EvidenceKind; title: string }> = [
	{ kind: "reported", title: "What was reported" },
	{ kind: "measured", title: "Measured (devices and labs)" },
	{ kind: "derived", title: "Derived scores" },
	{ kind: "nutrition_estimate", title: "Nutrition estimates" },
];

const directionText: Record<TrendObservation["direction"], string> = {
	up: "went up",
	down: "went down",
	flat: "about the same",
	single: "one value",
	text: "not a number",
};

/** Only provenance a reader needs: a lab's own value or a family member's report. */
const qualityText: Partial<Record<TrendObservation["quality"], string>> = {
	source_reported: "as the lab reported it",
	self_reported: "self-reported",
};

/** A lab date (`2025-03-01`) stays that calendar day; a source time shows in local time. */
const day = (iso: string) =>
	new Date(iso).toLocaleString([], {
		year: "numeric",
		month: "short",
		day: "numeric",
		...(iso.length <= 10
			? { timeZone: "UTC" }
			: { hour: "numeric", minute: "2-digit" }),
	});

function Trends() {
	const { state, family } = useFamily();
	return (
		<main className="p-2 sm:p-4">
			<Window
				title="Health trends"
				icon={TrendingUp}
				className="mx-auto w-full max-w-4xl"
			>
				<div className="grid gap-3 p-1 text-sm">
					<PersonPicker className="[&_select]:min-w-0 [&_select]:flex-1" />
					{family !== null ? (
						<TrendForm key={family.id} familyId={family.id} />
					) : state.kind === "ready" ? (
						<p className="win95-inset bg-card p-3">
							No person is paired with this account yet. People are paired
							manually.
						</p>
					) : (
						<ApiNotice state={state} what="health trends" />
					)}
				</div>
			</Window>
		</main>
	);
}

function TrendForm({ familyId }: { familyId: string }) {
	const [question, setQuestion] = useState("");
	const [days, setDays] = useState(7);
	const [result, setResult] = useState<
		ApiResult<TrendExplanation> | { kind: "loading" } | null
	>(null);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setResult({ kind: "loading" });
		setResult(
			await apiRequest(TrendExplanation, familyPath(familyId, "/trends"), {
				method: "POST",
				body: { question, days },
			}),
		);
	};
	return (
		<>
			<form onSubmit={submit} className="grid gap-2">
				<label htmlFor="trend-question" className="font-bold">
					Your question or what you noticed
				</label>
				<textarea
					id="trend-question"
					required
					maxLength={2000}
					rows={2}
					value={question}
					onChange={(event) => setQuestion(event.target.value)}
					placeholder="She seems more tired this week. Is her sleep changing?"
					className="win95-inset win95-field bg-card p-2"
				/>
				<div className="flex flex-wrap items-center gap-2">
					<label htmlFor="trend-days">Period</label>
					<select
						id="trend-days"
						value={days}
						onChange={(event) => setDays(Number(event.target.value))}
						className="win95-inset win95-field h-11 bg-card px-2"
					>
						{[7, 14, 30, 90].map((n) => (
							<option key={n} value={n}>
								Last {n} days
							</option>
						))}
					</select>
					<Button
						type="submit"
						className="ml-auto h-11"
						disabled={result?.kind === "loading" || !/\S/.test(question)}
					>
						Explain the trend
					</Button>
				</div>
			</form>
			{result !== null &&
				(result.kind === "ready" ? (
					<Explanation trend={result.value} />
				) : (
					<ApiNotice state={result} what="the trend explanation" />
				))}
		</>
	);
}

function Explanation({ trend }: { trend: TrendExplanation }) {
	const me = useApi(Me, "/api/me");
	const identity = me.kind === "ready" ? me.value.identity : null;
	const generated = Date.parse(trend.generatedAt);
	const [urgent, ...cautions] = trend.cautions;
	const heart = urgent?.includes("heart attack") === true;
	return (
		<article aria-label="Trend explanation" className="grid gap-3">
			{heart && (
				<p role="alert" className="win95-inset bg-card p-2 font-bold">
					{urgent}
				</p>
			)}
			<p className="text-muted-foreground text-xs">
				Records from {day(trend.from)} to {day(trend.to)}.
			</p>
			{groups.map(({ kind, title }) => {
				const rows = trend.observations.filter((o) => o.kind === kind);
				return (
					<section key={kind} aria-label={title} className="grid gap-1">
						<h3 className="font-bold">{title}</h3>
						{rows.length === 0 ? (
							<p className="win95-inset bg-card p-2 text-muted-foreground">
								None in this period.
							</p>
						) : (
							<ul className="win95-inset grid divide-y bg-card">
								{rows.map((o) => (
									<Observation
										key={`${o.label}|${o.source}|${o.unit}|${o.quality}|${o.synthetic}`}
										o={o}
										source={
											o.kind === "reported"
												? memberLabel(o.source, identity)
												: o.source
										}
										now={generated}
									/>
								))}
							</ul>
						)}
					</section>
				);
			})}
			<List
				title="Conflicting data"
				items={trend.conflicts}
				empty="None found."
			/>
			<List
				title="Unknown or missing"
				items={trend.unknown}
				empty="Nothing listed."
			/>
			<List
				title="Agreed in the care plan"
				items={[
					...trend.carePlan.routines.map(
						(r) =>
							`Routine: ${r.name}${r.time === null ? "" : ` at ${r.time}`}${r.timeZone === null ? "" : ` (${r.timeZone})`}`,
					),
					...trend.carePlan.instructions.map(
						(i) =>
							`${i.name}: ${i.instruction}${i.times.length === 0 ? "" : ` at ${i.times.join(", ")}`}${i.timeZone === null ? "" : ` (${i.timeZone})`}. Source: ${i.source}, from ${i.effectiveDate}.`,
					),
					...trend.carePlan.notes,
				]}
				empty="Nothing agreed."
			/>
			<List
				title="Next steps"
				items={trend.nextSteps.map((step) => step.text)}
				empty="None."
			/>
			<List
				title="Keep in mind"
				items={heart ? cautions : trend.cautions}
				empty="None."
			/>
		</article>
	);
}

function Observation({
	o,
	source,
	now,
}: {
	o: TrendObservation;
	source: string;
	now: number;
}) {
	const value = (v: string | number) =>
		typeof v === "number" && o.unit !== null
			? readingValue({ metric: o.label, value: v, unit: o.unit })
			: `${v}${o.unit === null ? "" : ` ${o.unit}`}`;
	const detail = [
		o.kind === "reported" ? source : sourceName(source),
		qualityText[o.quality],
		o.from === o.to ? day(o.from) : `${day(o.from)} – ${day(o.to)}`,
		`${o.count} ${o.count === 1 ? "value" : "values"}`,
		o.lastSyncAt === null
			? "sync time unknown"
			: `synced ${ago(o.lastSyncAt, now)}`,
	];
	return (
		<li className="grid">
			<Hint
				text={detail.filter((part) => part !== undefined).join(" · ")}
				className="flex flex-wrap items-baseline gap-x-2 p-2"
			>
				<b>{o.kind === "reported" ? "Question" : metricLabel(o.label)}</b>
				{o.kind === "reported" ? (
					<span>“{o.last}”</span>
				) : (
					<span>
						{o.count > 1 && `${value(o.first)} → `}
						{value(o.last)} · {directionText[o.direction]}
					</span>
				)}
				{o.synthetic && (
					<span className="win95-inset px-1 text-xs">Synthetic demo data</span>
				)}
				{o.stale && <span className="win95-inset px-1 text-xs">Old</span>}
			</Hint>
		</li>
	);
}

function List({
	title,
	items,
	empty,
}: {
	title: string;
	items: readonly string[];
	empty: string;
}) {
	return (
		<section aria-label={title} className="grid gap-1">
			<h3 className="font-bold">{title}</h3>
			<ul className="win95-inset grid list-inside list-disc gap-1 bg-card p-2">
				{items.length === 0 ? <li className="list-none">{empty}</li> : null}
				{items.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ul>
		</section>
	);
}
