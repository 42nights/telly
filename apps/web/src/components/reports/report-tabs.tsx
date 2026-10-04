import {
	mealFactText,
	type Report,
	type ReportMarker,
	unresolvedText,
} from "@health/contracts/reports";
import { Button } from "@health/ui/components/button";

import { CorrectionForm } from "./corrections";
import { DataTable } from "./data-table";
import { FinchnodeLabsPanel } from "./finchnode-labs";
import {
	demoText,
	FIELD_LABELS,
	FIELD_LIMITS,
	type FieldName,
	formatTime,
	markerValue,
	metricLabel,
} from "./logic";
import { PdfActions } from "./pdfs";
import { failureText, type ReportSheetState } from "./use-report-sheet";

const PATIENT_FIELDS = [
	"patientName",
	"dateOfBirth",
	"patientId",
	"physician",
	"hospital",
] as const;

function FieldInput({
	sheet,
	name,
}: {
	sheet: ReportSheetState;
	name: FieldName;
}) {
	const error = sheet.errors[name];
	return (
		<label className="grid gap-1 text-sm">
			{FIELD_LABELS[name]}
			<input
				className="win95-inset win95-field h-11 w-full bg-card px-2 text-sm"
				value={sheet.draft[name]}
				maxLength={FIELD_LIMITS[name] + 1}
				readOnly={sheet.reviewed}
				aria-invalid={error !== undefined}
				onChange={(event) =>
					sheet.setDraft({ ...sheet.draft, [name]: event.target.value })
				}
			/>
			{error !== undefined && <span className="text-destructive">{error}</span>}
		</label>
	);
}

function SaveBar({ sheet }: { sheet: ReportSheetState }) {
	if (sheet.reviewed) return null;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				type="button"
				className={`h-11 px-4 text-sm ${sheet.dirty ? "win95-primary" : ""}`}
				disabled={!sheet.dirty || !sheet.valid || sheet.busy !== null}
				onClick={() => void sheet.save()}
			>
				Save
			</Button>
			<span className="text-sm">
				{sheet.dirty ? "Changes not saved" : "All changes saved"}
			</span>
		</div>
	);
}

export function PatientTab({
	sheet,
	report,
}: {
	sheet: ReportSheetState;
	report: Report;
}) {
	return (
		<>
			<fieldset className="grid gap-2 border border-border p-2 sm:grid-cols-2">
				<legend className="px-1">Patient</legend>
				{PATIENT_FIELDS.map((name) => (
					<FieldInput key={name} sheet={sheet} name={name} />
				))}
			</fieldset>
			<SaveBar sheet={sheet} />
			<p>
				Generated {formatTime(report.createdAt)} ·{" "}
				{sheet.reviewed ? "reviewed, read-only" : "draft"}
			</p>
		</>
	);
}

/** One generated marker. A demo value is labeled; a correction sits beside the original. */
function MarkerRow({
	marker,
	sheet,
}: {
	marker: ReportMarker;
	sheet: ReportSheetState;
}) {
	const { metric, sample } = marker;
	const correction = sheet.draft.corrections.find((c) => c.metric === metric);
	return (
		<tr className="border-border border-t align-top">
			<td className="p-1.5">{metricLabel(metric)}</td>
			<td className="p-1.5">
				{markerValue(marker)}
				{sample?.synthetic && (
					<small className="block font-bold">Demo value, not measured</small>
				)}
				{correction !== undefined && (
					<small className="block">
						Corrected to {correction.value} {sample?.unit}: {correction.reason}.
						The value above is the original.
						{!sheet.reviewed && (
							<Button
								type="button"
								className="ml-2 h-11 px-3 text-sm"
								onClick={() =>
									sheet.setDraft({
										...sheet.draft,
										corrections: sheet.draft.corrections.filter(
											(c) => c !== correction,
										),
									})
								}
							>
								Remove
							</Button>
						)}
					</small>
				)}
			</td>
			<td className="p-1.5">
				{sample === null
					? "No source"
					: sample.synthetic
						? demoText(sample.source)
						: sample.source}
			</td>
			<td className="p-1.5">
				{sample === null ? "—" : formatTime(sample.sourceTime)}
			</td>
			<td className="p-1.5">
				{sample === null
					? "—"
					: sample.quality === "validated"
						? "Validated"
						: "Not validated"}
			</td>
		</tr>
	);
}

export function MarkersTab({
	report,
	familyId,
	sheet,
}: {
	report: Report;
	familyId: string;
	sheet: ReportSheetState;
}) {
	const demo = report.markers.filter((m) => m.sample?.synthetic).length;
	return (
		<>
			{demo > 0 && (
				<p role="note" className="win95-inset bg-card p-2 font-bold">
					Demo data: {demo} of these markers hold demo values, not real
					measurements.
				</p>
			)}
			{report.markers.length === 0 ? (
				<p className="win95-inset bg-card p-2">
					No measures were saved for this person when the report was made.
				</p>
			) : (
				<DataTable
					headers={[
						"Marker · latest",
						"Value",
						"Source",
						"Measured",
						"Quality",
					]}
				>
					{report.markers.map((marker) => (
						<MarkerRow key={marker.metric} marker={marker} sheet={sheet} />
					))}
				</DataTable>
			)}
			<p>
				Markers have no ranges or flags. Unavailable markers are kept in the
				report as unavailable. This report lists readings that were already
				saved: it is not a new lab test and not medical advice, and making it
				does not make an old reading current.
			</p>
			<CorrectionForm sheet={sheet} markers={report.markers} />
			<SaveBar sheet={sheet} />
			<FinchnodeLabsPanel familyId={familyId} />
		</>
	);
}

/** Saved lines of one report section; `null` when the report does not include the section. */
function SavedList({
	title,
	items,
	empty,
}: {
	title: string;
	items: readonly { readonly id: string; readonly text: string }[] | null;
	empty: string;
}) {
	return (
		<fieldset className="grid gap-1 border border-border p-2">
			<legend className="px-1">{title}</legend>
			{items === null ? (
				<p>Not included in this report.</p>
			) : items.length === 0 ? (
				<p>{empty}</p>
			) : (
				<ul className="grid gap-1">
					{items.map(({ id, text }) => (
						<li key={id}>{text}</li>
					))}
				</ul>
			)}
		</fieldset>
	);
}

/** Meal estimates, intake reports, and unresolved reminders as they stood at generation. */
export function DailyTab({ report }: { report: Report }) {
	return (
		<>
			<SavedList
				title="Nutrition estimates and intake reports"
				items={
					report.meals?.flatMap((meal) =>
						meal.facts.map((record) => ({
							id: record.id,
							text: mealFactText(record),
						})),
					) ?? null
				}
				empty="None saved."
			/>
			<SavedList
				title="Unresolved events"
				items={
					report.unresolved?.map((detail) => ({
						id: detail.occurrence.id,
						text: unresolvedText(detail),
					})) ?? null
				}
				empty="None."
			/>
			<p>
				These were saved before the report was made. A food estimate is not a
				measurement, and an unresolved reminder is neither done nor missed.
			</p>
		</>
	);
}

const NOTE_FIELDS = ["observations", "questions", "notes"] as const;

function LongField({
	sheet,
	name,
}: {
	sheet: ReportSheetState;
	name: (typeof NOTE_FIELDS)[number];
}) {
	const error = sheet.errors[name];
	return (
		<label className="grid gap-1">
			{FIELD_LABELS[name]}
			<textarea
				className="win95-inset win95-field h-28 w-full resize-none overflow-auto bg-card p-2 text-sm"
				placeholder="Optional"
				value={sheet.draft[name]}
				maxLength={FIELD_LIMITS[name] + 1}
				readOnly={sheet.reviewed}
				aria-invalid={error !== undefined}
				onChange={(event) =>
					sheet.setDraft({ ...sheet.draft, [name]: event.target.value })
				}
			/>
			<span className={error === undefined ? "" : "text-destructive"}>
				{error ??
					`${sheet.draft[name].trim().length} of ${FIELD_LIMITS[name]} characters`}
			</span>
		</label>
	);
}

export function NotesTab({ sheet }: { sheet: ReportSheetState }) {
	return (
		<>
			{NOTE_FIELDS.map((name) => (
				<LongField key={name} sheet={sheet} name={name} />
			))}
			<SaveBar sheet={sheet} />
		</>
	);
}

function ReviewGroup({
	sheet,
	report,
}: {
	sheet: ReportSheetState;
	report: Report;
}) {
	return (
		<fieldset className="grid gap-2 border border-border p-2">
			<legend className="px-1">Before sending</legend>
			{report.review !== null ? (
				<p>
					Reviewed {formatTime(report.review.reviewedAt)}. The report is
					read-only.
				</p>
			) : (
				<>
					{sheet.dirty && (
						<p>Save your changes before you mark the report as reviewed.</p>
					)}
					<label className="flex min-h-11 items-center gap-2">
						<input
							type="checkbox"
							className="size-5"
							checked={sheet.confirmed}
							onChange={(event) => sheet.setConfirmed(event.target.checked)}
						/>
						I reviewed every field. After this, the report cannot change.
					</label>
					<Button
						type="button"
						className="win95-primary h-11 justify-self-start px-4 text-sm"
						disabled={!sheet.confirmed || sheet.dirty || sheet.busy !== null}
						onClick={() => void sheet.review()}
					>
						Mark as reviewed
					</Button>
				</>
			)}
		</fieldset>
	);
}

export function SendTab({
	sheet,
	report,
	reports,
	familyId,
	onAsk,
}: {
	sheet: ReportSheetState;
	report: Report;
	reports: readonly Report[];
	familyId: string;
	onAsk: () => void;
}) {
	const { reviewed, sendFailure } = sheet;
	return (
		<>
			<ReviewGroup sheet={sheet} report={report} />
			<fieldset className="grid gap-2 border border-border p-2">
				<legend className="px-1">Send and PDF</legend>
				{sendFailure === null ? (
					<p>
						Hospital: not sent.
						{!reviewed && " Mark the report as reviewed first."}
					</p>
				) : (
					<p role="alert" className="font-bold">
						{sendFailure.kind === "unavailable"
							? sendFailure.message
							: `Not sent: ${failureText(sendFailure)}`}
					</p>
				)}
				<EmailStatus email={report.email} />
				<p>
					A family review is not a clinician review. Sending a report does not
					mean that a clinician has read it.
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						className={`h-11 px-4 text-sm ${reviewed && sendFailure === null ? "win95-primary" : ""}`}
						disabled={!reviewed || sheet.busy !== null}
						onClick={onAsk}
					>
						Send to hospital…
					</Button>
					<Button
						type="button"
						className="h-11 px-4 text-sm"
						disabled={!reviewed || sheet.busy !== null}
						onClick={() => void sheet.email()}
					>
						Send by email
					</Button>
					<PdfActions
						familyId={familyId}
						reportId={report.id}
						reports={reports}
					/>
				</div>
			</fieldset>
		</>
	);
}

/** The latest email of the report: not emailed, sending, sent, or failed with its reason. */
function EmailStatus({ email }: { email: Report["email"] }) {
	if (email === null) return <p role="status">Email: not emailed.</p>;
	const at = formatTime(email.updatedAt);
	return (
		<p role="status">
			Email:{" "}
			{email.status === "queued"
				? `sending to ${email.recipient}…`
				: email.status === "sent"
					? `sent to ${email.recipient} ${at}${email.automatic ? " (automatic)" : ""}.`
					: `failed to ${email.recipient} ${at}: ${email.reason ?? "no reason given"}`}
		</p>
	);
}

/** The message box that confirms a send. */
export function SendDialog({
	hospital,
	onSend,
	onCancel,
}: {
	hospital: string | null;
	onSend: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-3">
			<div
				role="alertdialog"
				onKeyDown={(event) => event.key === "Escape" && onCancel()}
				aria-modal="true"
				aria-labelledby="report-send-title"
				className="win95-raised w-full max-w-sm"
			>
				<h3 id="report-send-title" className="win95-titlebar px-2 py-1 text-sm">
					Send report
				</h3>
				<div className="grid gap-3 p-3 text-sm">
					<p>
						Send this report to {hospital ?? "the hospital"}? You will see the
						server's answer here.
					</p>
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							className="win95-primary h-11 px-4 text-sm"
							autoFocus
							onClick={onSend}
						>
							Send
						</Button>
						<Button
							type="button"
							className="h-11 px-4 text-sm"
							onClick={onCancel}
						>
							Cancel
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
