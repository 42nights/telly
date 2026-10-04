import type { Report } from "@health/contracts/reports";
import { Button } from "@health/ui/components/button";

import { DataTable } from "./data-table";
import { FinchnodeLabsPanel } from "./finchnode-labs";
import {
	FIELD_LABELS,
	FIELD_LIMITS,
	type FieldDraft,
	formatTime,
	markerValue,
	metricLabel,
} from "./logic";
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
	name: keyof FieldDraft;
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

export function MarkersTab({
	report,
	familyId,
}: {
	report: Report;
	familyId: string;
}) {
	return (
		<>
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
					{report.markers.map(({ metric, sample }) => (
						<tr key={metric} className="border-border border-t">
							<td className="p-1.5">{metricLabel(metric)}</td>
							<td className="p-1.5">{markerValue({ metric, sample })}</td>
							<td className="p-1.5">{sample?.source ?? "No source"}</td>
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
					))}
				</DataTable>
			)}
			<p>
				Markers have no ranges or flags. Unavailable markers are kept in the
				report as unavailable.
			</p>
			<FinchnodeLabsPanel familyId={familyId} />
		</>
	);
}

export function NotesTab({ sheet }: { sheet: ReportSheetState }) {
	const error = sheet.errors.notes;
	return (
		<>
			<label className="grid gap-1">
				{FIELD_LABELS.notes}
				<textarea
					className="win95-inset win95-field h-40 w-full resize-none overflow-auto bg-card p-2 text-sm"
					placeholder="Optional"
					value={sheet.draft.notes}
					maxLength={FIELD_LIMITS.notes + 1}
					readOnly={sheet.reviewed}
					aria-invalid={error !== undefined}
					onChange={(event) =>
						sheet.setDraft({ ...sheet.draft, notes: event.target.value })
					}
				/>
				<span className={error === undefined ? "" : "text-destructive"}>
					{error ??
						`${sheet.draft.notes.trim().length} of ${FIELD_LIMITS.notes} characters`}
				</span>
			</label>
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
	onAsk,
}: {
	sheet: ReportSheetState;
	report: Report;
	onAsk: () => void;
}) {
	const { reviewed, sendFailure } = sheet;
	return (
		<>
			<ReviewGroup sheet={sheet} report={report} />
			<fieldset className="grid gap-2 border border-border p-2">
				<legend className="px-1">Send to hospital</legend>
				{sendFailure === null ? (
					<p>
						Not sent.
						{!reviewed && " Mark the report as reviewed first."}
					</p>
				) : (
					<p role="alert" className="font-bold">
						{sendFailure.kind === "unavailable"
							? sendFailure.message
							: `Not sent: ${failureText(sendFailure)}`}
					</p>
				)}
				<Button
					type="button"
					className={`h-11 justify-self-start px-4 text-sm ${reviewed && sendFailure === null ? "win95-primary" : ""}`}
					disabled={!reviewed || sheet.busy !== null}
					onClick={onAsk}
				>
					Send to hospital…
				</Button>
			</fieldset>
		</>
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
