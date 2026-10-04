import {
	classify,
	type LabCorrection,
	type LabReport,
	type ReferenceRange,
} from "@health/contracts/lab-report";
import type { ReactNode } from "react";

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
			<span className="whitespace-nowrap font-bold text-destructive">
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
			{range && typeof shown === "number" && (
				<Flag value={shown} range={range} />
			)}
			{correction && (
				<>
					{" (corrected)"}
					<span className="block text-sm">
						Record value: {String(result.value)}
						{range && typeof result.value === "number" && (
							<Flag value={result.value} range={range} />
						)}
					</span>
				</>
			)}
		</div>
	);
}

const cell = "border border-black p-2 text-left align-top";

/** Every report table: scrolls sideways on a phone, prints in full. */
function ReportTable({
	caption,
	children,
}: {
	caption: string;
	children: ReactNode;
}) {
	return (
		<div className="relative overflow-x-auto print:overflow-visible">
			<table className="w-full border-collapse text-base print:text-[10pt]">
				<caption className="caption-top pb-2 text-left">{caption}</caption>
				{children}
			</table>
		</div>
	);
}

/** Body-system grouping. TSH is the only
 * hormone here, so its section is named Thyroid. A code not listed goes under "Other results". */
const GROUPS: readonly (readonly [string, readonly string[]])[] = [
	["Heart and lipids", ["2093-3", "2085-9", "13457-7", "2571-8"]],
	["Metabolic", ["4548-4"]],
	["Thyroid", ["3016-3"]],
	[
		"Kidney and electrolytes",
		["2160-0", "98979-8", "3094-0", "2951-2", "2823-3"],
	],
	["Blood count", ["718-7", "6690-2", "777-3"]],
];
const groupOf = (loinc: string) =>
	GROUPS.find(([, codes]) => codes.includes(loinc))?.[0] ?? "Other results";

export function LabTable({
	results,
	corrections,
	synthetic,
}: {
	synthetic: boolean;
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
			<ReportTable
				caption={`${synthetic ? "Synthetic demo data. " : ""}Values, units, and ranges as written in the source record. Columns are specimen collection dates. Rows are grouped by body system.`}
			>
				<thead>
					<tr>
						<th scope="col" className={cell}>
							Test
						</th>
						{dates.map((date) => (
							<th
								key={date}
								scope="col"
								className={`${cell} whitespace-nowrap`}
							>
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
				{[...GROUPS.map(([name]) => name), "Other results"].map((group) => {
					const inGroup = [...rows].filter(
						([, [first]]) => groupOf(first?.loinc ?? "") === group,
					);
					return (
						inGroup.length > 0 && (
							<tbody key={group}>
								<tr>
									<th
										colSpan={dates.length + 3}
										scope="rowgroup"
										className={`${cell} font-bold`}
									>
										{group}
									</th>
								</tr>
								{inGroup.map(([key, row]) => {
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
											<td className={cell}>{first.unit ?? ""}</td>
											<td className={cell}>
												{first.referenceRange?.text ?? ""}
											</td>
										</tr>
									);
								})}
							</tbody>
						)
					);
				})}
			</ReportTable>
			<p>
				▲ H: above the range in the record · ▼ L: below the range in the record
				· no mark: within the range in the record · —: not tested on this date
			</p>
			<p>
				Flags compare each value with the range in its own record, bounds
				included. No interpretation is given.
			</p>
		</>
	);
}
