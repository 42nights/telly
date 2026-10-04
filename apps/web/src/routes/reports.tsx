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
import {
	CorrectionForm,
	NoteForm,
	NoteList,
} from "@/components/report/review-forms";

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
			{/* An unreadable report, or one with no results, is unavailable: never blank, never "all clear". */}
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
					<>
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
						{!Schema.is(ReviewerName)(reviewer.trim()) && (
							<p>Enter your name above to mark the report reviewed.</p>
						)}
					</>
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
				<p>Finchnode reads records but cannot deliver a report.</p>
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
	// The contract requires at least one result, so this is a real collection time.
	const latest = Math.max(
		...report.results.map((r) => Date.parse(r.collectedAt)),
	);
	const lines: [string, string][] = [
		[
			"Patient",
			`${patient.name} · ${patient.sex} · Born ${patient.birthDate} · Record ID ${patient.recordId}`,
		],
		[
			"Blood results source",
			`${source.name}, fetched ${formatUtc(source.fetchedAt)} · SHA-256 ${source.sha256.slice(0, 12)}…`,
		],
		[
			"Summary generated",
			`${formatTime(generatedAt)}. This is a summary of existing results, not a new lab test. Each result keeps its own collection date.`,
		],
		[
			"Most recent blood result",
			`${formatDate(new Date(latest).toISOString())} (${Math.floor((generatedAt.getTime() - latest) / DAY_MS)} days before this summary)`,
		],
		["Layout", `v${report.layoutVersion}`],
		[
			"Status",
			reviewed
				? `Reviewed by ${reviewed.by} on ${formatTime(reviewed.at)}. A family member's review is not a clinician review.`
				: "Draft. Not reviewed.",
		],
		["Delivery", "Not sent."],
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

/** Prints; rendered only when there is a correction. `onRemove` is `undefined` once the report is reviewed. */
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
			<ul className="grid gap-2">
				{results.map((result) => {
					const c = corrections.get(result.id);
					return (
						c && (
							<li key={result.id}>
								{`${shortName(result.name)} · ${formatDate(result.collectedAt)}: record ${result.value} ${result.unit ?? ""}, corrected to ${c.value} ${result.unit ?? ""} · by ${c.correctedBy} · ${formatTime(c.correctedAt)}`}
								{onRemove && (
									<Button
										type="button"
										onClick={() => onRemove(result.id)}
										aria-label={`Remove correction to ${shortName(result.name)}, ${formatDate(result.collectedAt)}`}
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
		</>
	);
}

/** Shown only when the source marks the record synthetic; a real record has no banner. */
function SyntheticBanner({ synthetic }: { synthetic: boolean }) {
	if (!synthetic) return null;
	return (
		<p className="border-2 border-black border-solid p-2 font-bold">
			Synthetic demo data · Not a real person · Not from a laboratory
		</p>
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
				<SyntheticBanner synthetic={report.synthetic} />
				<h1 id={headingId} className="mt-4 font-bold text-3xl">
					Health summary: blood results
				</h1>
				<Meta report={report} generatedAt={generatedAt} reviewed={reviewed} />

				<Section n={1} title="Blood results">
					<LabTable
						results={results}
						corrections={corrections}
						synthetic={report.synthetic}
					/>
					{corrections.size > 0 && (
						<Corrections
							results={results}
							corrections={corrections}
							onRemove={draft ? removeCorrection : undefined}
						/>
					)}
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
				</Section>

				{/* A section with no entries is left out; its screen-only form still shows while drafting. */}
				{observations.length > 0 && (
					<Section n={2} title="Caregiver observations">
						<NoteList notes={observations} />
					</Section>
				)}
				{draft && (
					<NoteForm
						label="New caregiver observation"
						reviewer={reviewer}
						onAdd={(note) => setObservations((previous) => [...previous, note])}
					/>
				)}
				{questions.length > 0 && (
					<Section
						n={observations.length > 0 ? 3 : 2}
						title="Questions for a clinician"
					>
						<NoteList notes={questions} />
					</Section>
				)}
				{draft && (
					<NoteForm
						label="New question for a clinician"
						reviewer={reviewer}
						onAdd={(note) => setQuestions((previous) => [...previous, note])}
					/>
				)}

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
