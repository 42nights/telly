import {
	classify,
	type LabCorrection,
	type LabReport,
	type ReferenceRange,
} from "@health/contracts/lab-report";

type LabResult = LabReport["results"][number];

/** The record's test name up to its LOINC property bracket: "Hemoglobin [Mass/volume] in Blood" → "Hemoglobin". */
export const shortName = (name: string) => name.split(" [")[0] ?? name;

/** A specimen collection date, in UTC so a draw never shifts a day with the viewer's time zone. */
export const formatDate = (iso: string) =>
	new Date(iso).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

/** When something happened on this page, in the viewer's local time. */
export const formatTime = (time: Date | string) =>
	new Date(time).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});

const FLAGS = {
	H: { glyph: "▲", words: "above the range in the record" },
	L: { glyph: "▼", words: "below the range in the record" },
} as const;

/** The glyph and the letter both carry the flag, so colour is never the only cue. */
function Flag({ value, range }: { value: number; range: ReferenceRange }) {
	const flag = classify(value, range);
	if (flag === "N") return null;
	return (
		<>
			{" "}
			<span className="font-bold text-destructive">
				<span aria-hidden>{FLAGS[flag].glyph}</span> {flag}
			</span>
			<span className="sr-only"> {FLAGS[flag].words}</span>
		</>
	);
}

function Reading({
	result,
	correction,
}: {
	result: LabResult;
	correction: LabCorrection | undefined;
}) {
	const range = result.referenceRange;
	const shown = correction?.value ?? result.value;
	return (
		<div>
			{String(shown)}
			{range && <Flag value={shown} range={range} />}
			{correction && (
				<>
					{" (corrected)"}
					<span className="block text-sm">
						Record value: {String(result.value)}
						{range && <Flag value={result.value} range={range} />}
					</span>
				</>
			)}
		</div>
	);
}

const cell = "border border-black p-2 text-left align-top";

export function LabTable({
	results,
	corrections,
}: {
	results: readonly LabResult[];
	corrections: ReadonlyMap<string, LabCorrection>;
}) {
	const dates = [...new Set(results.map((r) => r.collectedAt))].sort(
		(a, b) => Date.parse(a) - Date.parse(b),
	);
	// A changed unit or range starts its own row; rows are never merged across them.
	const rows = new Map<string, LabResult[]>();
	for (const result of results) {
		const key = `${result.loinc}|${result.unit}|${result.referenceRange?.text ?? ""}`;
		rows.set(key, [...(rows.get(key) ?? []), result]);
	}

	return (
		<>
			<div className="relative overflow-x-auto print:overflow-visible">
				<table className="w-full border-collapse text-base print:text-[10pt]">
					<caption className="caption-top pb-2 text-left">
						Synthetic demo data. Values, units, and ranges as written in the
						source record. Columns are specimen collection dates.
					</caption>
					<thead>
						<tr>
							<th scope="col" className={cell}>
								Test
							</th>
							{dates.map((date) => (
								<th key={date} scope="col" className={cell}>
									<time dateTime={date}>{formatDate(date)}</time>
								</th>
							))}
							<th scope="col" className={cell}>
								Units
							</th>
							<th scope="col" className={cell}>
								Range in the record
							</th>
						</tr>
					</thead>
					<tbody>
						{[...rows].map(([key, row]) => {
							const [first] = row;
							if (first === undefined) return null;
							return (
								<tr key={key} className="break-inside-avoid">
									<th scope="row" className={cell}>
										<span className="block font-bold">
											{shortName(first.name)}
										</span>
										<span className="block font-normal text-sm">
											LOINC {first.loinc}
										</span>
									</th>
									{dates.map((date) => {
										const drawn = row.filter((r) => r.collectedAt === date);
										return (
											<td key={date} className={cell}>
												{drawn.length === 0 ? (
													<>
														<span aria-hidden>—</span>
														<span className="sr-only">
															not tested on this date
														</span>
													</>
												) : (
													drawn.map((result) => (
														<Reading
															key={result.id}
															result={result}
															correction={corrections.get(result.id)}
														/>
													))
												)}
											</td>
										);
									})}
									<td className={cell}>{first.unit}</td>
									<td className={cell}>
										{first.referenceRange?.text ?? "No range in the record"}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<p>
				▲ H: above the range in the record · ▼ L: below the range in the record
				· no mark: within the range in the record · —: not tested on this date
			</p>
			<p>
				Flags compare each value with the range in its own record, bounds
				included. No interpretation is given. Measurement uncertainty is not
				provided in the record.
			</p>
		</>
	);
}
