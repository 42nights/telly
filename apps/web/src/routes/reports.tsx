import { type Loaded, loadDecoded } from "@health/contracts";
import {
	type LabCorrection,
	LabReport,
	ReviewerName,
	type ReviewNote,
} from "@health/contracts/lab-report";
import { Button } from "@health/ui/components/button";
import { Input } from "@health/ui/components/input";
import { Label } from "@health/ui/components/label";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import {
	formatDate,
	formatTime,
	LabTable,
	shortName,
} from "@/components/report/lab-table";
import { CorrectionForm, NoteSection } from "@/components/report/review-forms";

export const Route = createFileRoute("/reports")({
	component: ReportsComponent,
});

const DAY_MS = 86_400_000;

/** Source fetch time, such as "Oct 4, 2026, 01:09 UTC". */
const formatUtc = (iso: string) =>
	`${new Date(iso).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZone: "UTC",
	})} UTC`;

function ReportsComponent() {
	const [state, setState] = useState<Loaded<LabReport>>();

	useEffect(
		() =>
			loadDecoded(LabReport, "/fixtures/lab-report.synthetic.json", setState),
		[],
	);

	return (
		<main className="min-h-0 overflow-y-auto p-2 print:overflow-visible print:bg-white print:p-0">
			{state === undefined && <p>Loading the report…</p>}
			{/* An unreadable report is unavailable, never blank and never "all clear". */}
			{state?.kind === "error" && (
				<p role="alert">Report unavailable: {state.message}</p>
			)}
			{state?.kind === "ready" && <Report report={state.value} />}
		</main>
	);
}

function Section({
	n,
	title,
	children,
}: {
	n: number;
	title: string;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<section aria-labelledby={id} className="mt-8 grid gap-3">
			<h2 id={id} className="break-after-avoid font-bold text-2xl">
				{n}. {title}
			</h2>
			{children}
		</section>
	);
}

type LabResult = LabReport["results"][number];
type Review = { by: string; at: string };

/** Screen only: who is reviewing, the review step, printing, and the separate (unavailable) send. */
function Toolbar({
	reviewer,
	onReviewer,
	reviewed,
	onReview,
}: {
	reviewer: string;
	onReviewer: (reviewer: string) => void;
	reviewed: Review | undefined;
	onReview: (review: Review) => void;
}) {
	const nameId = useId();
	const status = useRef<HTMLParagraphElement>(null);

	// The button goes away on review, so focus moves to the status that replaces it.
	useEffect(() => {
		if (reviewed) status.current?.focus();
	}, [reviewed]);

	return (
		<div className="mx-auto mb-2 grid max-w-5xl gap-3 bg-card p-4 text-card-foreground text-lg print:hidden">
			<div className="grid gap-1">
				<Label htmlFor={nameId} className="text-base">
					Your name (reviewer)
				</Label>
				<Input
					id={nameId}
					value={reviewer}
					onChange={(event) => onReviewer(event.currentTarget.value)}
					disabled={reviewed !== undefined}
					autoComplete="name"
					className="h-11 max-w-sm text-base md:text-base"
				/>
			</div>
			<p>
				Changes stay in this tab until you reload. Nothing is saved or sent.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				{reviewed === undefined ? (
					<Button
						type="button"
						disabled={!Schema.is(ReviewerName)(reviewer.trim())}
						onClick={() =>
							onReview({ by: reviewer.trim(), at: new Date().toISOString() })
						}
						className="px-4 text-base"
					>
						Mark reviewed
					</Button>
				) : (
					<p role="status" tabIndex={-1} ref={status} className="font-bold">
						Reviewed. Ready for the Finchnode handoff. Not sent.
					</p>
				)}
				<Button
					type="button"
					onClick={() => window.print()}
					className="px-4 text-base"
				>
					Print or save as PDF
				</Button>
				<Button type="button" disabled className="px-4 text-base">
					Send to hospital (Finchnode)
				</Button>
				<p>
					Not available yet: Finchnode reads records but cannot deliver a
					report.
				</p>
			</div>
		</div>
	);
}

/** The header lines: who, where the record came from, when, and the review and delivery state. */
function Meta({
	report,
	generatedAt,
	reviewed,
}: {
	report: LabReport;
	generatedAt: Date;
	reviewed: Review | undefined;
}) {
	const { patient, source } = report;
	const latest = report.results
		.map((r) => r.collectedAt)
		.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
	const lines: [string, string][] = [
		[
			"Patient",
			`${patient.name} · ${patient.sex} · Born ${patient.birthDate} · Record ID ${patient.recordId}`,
		],
		[
			"Source record",
			`${source.name}, fetched ${formatUtc(source.fetchedAt)} · SHA-256 ${source.sha256.slice(0, 12)}…`,
		],
		["Performing laboratory", "None (synthetic demo data)"],
		[
			"Summary generated",
			`${formatTime(generatedAt)}. This is a summary of existing results, not a new lab test. Each result keeps its own collection date.`,
		],
		[
			"Most recent result",
			latest === undefined
				? "Not available. The source record has no laboratory results."
				: `${formatDate(latest)} (${Math.floor((generatedAt.getTime() - Date.parse(latest)) / DAY_MS)} days before this summary)`,
		],
		["Layout", `v${report.layoutVersion}`],
		[
			"Status",
			reviewed
				? `Reviewed by ${reviewed.by} on ${formatTime(reviewed.at)}. A family member's review is not a clinician review.`
				: "Draft. Not reviewed.",
		],
		[
			"Delivery",
			"Not sent. Sending to a hospital through Finchnode is not available yet.",
		],
	];
	return (
		<dl className="mt-4 grid gap-1">
			{lines.map(([term, detail]) => (
				<div key={term}>
					<dt className="inline font-bold">{term}: </dt>
					<dd className="inline">{detail}</dd>
				</div>
			))}
		</dl>
	);
}

/** Prints. `onRemove` is `undefined` once the report is reviewed. */
function Corrections({
	results,
	corrections,
	onRemove,
}: {
	results: readonly LabResult[];
	corrections: ReadonlyMap<string, LabCorrection>;
	onRemove: ((resultId: string) => void) | undefined;
}) {
	return (
		<>
			<h3 className="break-after-avoid font-bold text-xl">
				Corrections by the reviewer (record values kept)
			</h3>
			{corrections.size === 0 ? (
				<p>No corrections were made. Values are as recorded.</p>
			) : (
				<ul className="grid gap-2">
					{results.map((result) => {
						const c = corrections.get(result.id);
						return (
							c && (
								<li key={result.id}>
									{`${shortName(result.name)} · ${formatDate(result.collectedAt)}: record ${result.value} ${result.unit}, corrected to ${c.value} ${result.unit} · by ${c.correctedBy} · ${formatTime(c.correctedAt)}`}
									{onRemove && (
										<Button
											type="button"
											onClick={() => onRemove(result.id)}
											className="ml-2 px-4 text-base print:hidden"
										>
											Remove
										</Button>
									)}
								</li>
							)
						);
					})}
				</ul>
			)}
		</>
	);
}

function Report({ report }: { report: LabReport }) {
	const headingId = useId();
	const [generatedAt] = useState(() => new Date());
	const [reviewer, setReviewer] = useState("");
	const [reviewed, setReviewed] = useState<Review>();
	const [corrections, setCorrections] = useState(
		() => new Map<string, LabCorrection>(),
	);
	const [observations, setObservations] = useState<ReviewNote[]>([]);
	const [questions, setQuestions] = useState<ReviewNote[]>([]);

	const draft = reviewed === undefined;
	const { results } = report;
	const removeCorrection = (resultId: string) =>
		setCorrections((previous) => {
			const next = new Map(previous);
			next.delete(resultId);
			return next;
		});

	return (
		<>
			<Toolbar
				reviewer={reviewer}
				onReviewer={setReviewer}
				reviewed={reviewed}
				onReview={setReviewed}
			/>
			<article
				aria-labelledby={headingId}
				className="mx-auto max-w-5xl bg-card p-4 text-card-foreground text-lg md:p-8 print:max-w-none print:p-0 print:text-[11pt]"
			>
				{report.synthetic && (
					<p className="border-2 border-black border-solid p-2 font-bold">
						Synthetic demo data · Not a real person · Not from a laboratory
					</p>
				)}
				<h1 id={headingId} className="mt-4 font-bold text-3xl">
					Lab results summary
				</h1>
				<Meta report={report} generatedAt={generatedAt} reviewed={reviewed} />

				<Section n={1} title="Dated laboratory results">
					{results.length === 0 ? (
						<p>Not available. The source record has no laboratory results.</p>
					) : (
						<>
							<LabTable results={results} corrections={corrections} />
							<Corrections
								results={results}
								corrections={corrections}
								onRemove={draft ? removeCorrection : undefined}
							/>
							{draft && (
								<CorrectionForm
									results={results}
									reviewer={reviewer}
									onCorrect={(c) =>
										setCorrections((previous) =>
											new Map(previous).set(c.resultId, c),
										)
									}
								/>
							)}
						</>
					)}
				</Section>

				{/* ponytail: sections 2, 3, 5, and 6 stay static text until a connected source and its contract exist. */}
				<Section n={2} title="Wearable observations">
					<p>
						Not available. NOOP is not connected, so no wearable readings are
						included. A wearable score is not a blood test.
					</p>
				</Section>
				<Section n={3} title="Wearer reports">
					<p>
						Not available. No source for the wearer's own reports is connected
						yet.
					</p>
				</Section>
				<Section n={4} title="Caregiver observations">
					<NoteSection
						label="New caregiver observation"
						emptyText="Not available. No caregiver observations were added."
						notes={observations}
						reviewer={reviewer}
						onAdd={
							draft
								? (note) => setObservations((previous) => [...previous, note])
								: undefined
						}
					/>
				</Section>
				<Section n={5} title="Nutrition estimates">
					<p>Not available. No nutrition source is connected yet.</p>
				</Section>
				<Section n={6} title="Unresolved events">
					<p>
						Not available. No event source is connected yet, so this section
						cannot say whether anything is unresolved.
					</p>
				</Section>
				<Section n={7} title="Questions for a clinician">
					<NoteSection
						label="New question for a clinician"
						emptyText="Not available. No questions were added."
						notes={questions}
						reviewer={reviewer}
						onAdd={
							draft
								? (note) => setQuestions((previous) => [...previous, note])
								: undefined
						}
					/>
				</Section>

				<footer className="mt-8 border-black border-t-2 pt-4">
					Demonstration only, made from synthetic data. This is not a laboratory
					report and not medical advice. Ranges are the ones written in the
					source record. A healthcare professional may be able to help explain
					these results. Layout v{report.layoutVersion}.
				</footer>
			</article>
		</>
	);
}
