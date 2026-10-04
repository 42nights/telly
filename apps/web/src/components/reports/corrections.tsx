import { ReportCorrection, type ReportMarker } from "@health/contracts/reports";
import { Button } from "@health/ui/components/button";
import { Schema } from "effect";
import { type FormEvent, useId, useState } from "react";

import { markerValue, metricLabel } from "./logic";
import type { ReportSheetState } from "./use-report-sheet";

/**
 * Adds one correction to the draft. Only a measured marker without a correction is offered; the
 * generated value stays in the report. The correction is saved with the other fields.
 */
export function CorrectionForm({
	sheet,
	markers,
}: {
	sheet: ReportSheetState;
	markers: readonly ReportMarker[];
}) {
	const id = useId();
	const open = markers.filter(
		(m) =>
			m.sample !== null &&
			!sheet.draft.corrections.some((c) => c.metric === m.metric),
	);
	const [metric, setMetric] = useState("");
	const [value, setValue] = useState("");
	const [reason, setReason] = useState("");
	const [error, setError] = useState<string | null>(null);
	const chosen = open.find((m) => m.metric === metric) ?? open[0];
	if (sheet.reviewed || chosen === undefined) return null;

	const add = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const correction = {
			metric: chosen.metric,
			// An empty box is not 0.
			value: value.trim() === "" ? Number.NaN : Number(value),
			reason: reason.trim(),
		};
		if (!Schema.is(ReportCorrection)(correction))
			return setError(
				"Enter the correct number and a reason (up to 200 characters).",
			);
		setError(null);
		setValue("");
		setReason("");
		sheet.setDraft({
			...sheet.draft,
			corrections: [...sheet.draft.corrections, correction],
		});
	};

	return (
		<form onSubmit={add}>
			<fieldset className="grid gap-2 border border-border p-2 sm:grid-cols-3">
				<legend className="px-1">Correct a value</legend>
				<label className="grid gap-1" htmlFor={`${id}-metric`}>
					Marker
					<select
						id={`${id}-metric`}
						className="win95-inset win95-field h-11 bg-card px-2 text-sm"
						value={chosen.metric}
						onChange={(event) => setMetric(event.target.value)}
					>
						{open.map((m) => (
							<option key={m.metric} value={m.metric}>
								{metricLabel(m.metric)} · {markerValue(m)}
							</option>
						))}
					</select>
				</label>
				<label className="grid gap-1" htmlFor={`${id}-value`}>
					Correct value ({chosen.sample?.unit})
					<input
						id={`${id}-value`}
						type="number"
						step="any"
						inputMode="decimal"
						className="win95-inset win95-field h-11 bg-card px-2 text-sm"
						value={value}
						onChange={(event) => setValue(event.target.value)}
					/>
				</label>
				<label className="grid gap-1" htmlFor={`${id}-reason`}>
					Reason
					<input
						id={`${id}-reason`}
						className="win95-inset win95-field h-11 bg-card px-2 text-sm"
						maxLength={201}
						value={reason}
						onChange={(event) => setReason(event.target.value)}
					/>
				</label>
				{error !== null && (
					<p role="alert" className="text-destructive sm:col-span-3">
						{error}
					</p>
				)}
				<p className="sm:col-span-2">
					The value from the source stays in the report beside the correction.
				</p>
				<Button type="submit" className="h-11 justify-self-start px-4 text-sm">
					Add correction
				</Button>
			</fieldset>
		</form>
	);
}
