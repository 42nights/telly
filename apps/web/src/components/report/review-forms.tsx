import {
	LabCorrection,
	type LabReport,
	ReviewerName,
	ReviewNote,
} from "@health/contracts/lab-report";
import { Button } from "@health/ui/components/button";
import { Input } from "@health/ui/components/input";
import { Label } from "@health/ui/components/label";
import { Textarea } from "@health/ui/components/textarea";
import { Schema } from "effect";
import { type FormEvent, useId, useRef, useState } from "react";

import { formatDate, formatTime, shortName } from "./lab-table";

type LabResult = LabReport["results"][number];

/** Names the missing reviewer first, since every change carries who made it. */
const problem = (reviewer: string, otherwise: string) =>
	Schema.is(ReviewerName)(reviewer.trim())
		? otherwise
		: "Enter your name above first (up to 80 characters).";

const field = "h-11 text-base md:text-base";

function Submit({
	error,
	label,
}: {
	error: string | undefined;
	label: string;
}) {
	return (
		<>
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			<Button type="submit" className="justify-self-start px-4 text-base">
				{label}
			</Button>
		</>
	);
}

export function CorrectionForm({
	results,
	reviewer,
	onCorrect,
}: {
	results: readonly LabResult[];
	reviewer: string;
	onCorrect: (correction: LabCorrection) => void;
}) {
	const id = useId();
	const [resultId, setResultId] = useState(results[0]?.id ?? "");
	const [text, setText] = useState("");
	const [error, setError] = useState<string>();

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const raw = text.trim();
		const correction = {
			resultId,
			// A blank field is not 0.
			value: raw === "" ? Number.NaN : Number(raw),
			correctedBy: reviewer.trim(),
			correctedAt: new Date().toISOString(),
		};
		if (!Schema.is(LabCorrection)(correction)) {
			setError(problem(reviewer, "Enter a number."));
			return;
		}
		setError(undefined);
		setText("");
		onCorrect(correction);
	};

	return (
		<form onSubmit={submit} className="grid gap-2 print:hidden">
			<Label htmlFor={`${id}-result`} className="text-base">
				Result to correct
			</Label>
			<select
				id={`${id}-result`}
				value={resultId}
				onChange={(event) => setResultId(event.currentTarget.value)}
				className={`win95-inset bg-card px-2 ${field}`}
			>
				{results.map((r) => (
					<option key={r.id} value={r.id}>
						{`${shortName(r.name)} · ${formatDate(r.collectedAt)} · ${r.value} ${r.unit}`}
					</option>
				))}
			</select>
			<Label htmlFor={`${id}-value`} className="text-base">
				Corrected value
			</Label>
			<Input
				id={`${id}-value`}
				type="number"
				step="any"
				inputMode="decimal"
				value={text}
				onChange={(event) => setText(event.currentTarget.value)}
				className={`max-w-xs ${field}`}
			/>
			<Submit error={error} label="Add correction" />
		</form>
	);
}

export function NoteSection({
	label,
	emptyText,
	notes,
	reviewer,
	onAdd,
}: {
	label: string;
	emptyText: string;
	notes: readonly ReviewNote[];
	reviewer: string;
	/** `undefined` once the report is reviewed: the list stays, the form goes. */
	onAdd: ((note: ReviewNote) => void) | undefined;
}) {
	const id = useId();
	const input = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState("");
	const [error, setError] = useState<string>();

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const note = {
			text: text.trim(),
			by: reviewer.trim(),
			at: new Date().toISOString(),
		};
		if (!Schema.is(ReviewNote)(note)) {
			setError(problem(reviewer, "Enter some text (up to 500 characters)."));
			return;
		}
		setError(undefined);
		setText("");
		input.current?.focus();
		onAdd?.(note);
	};

	return (
		<>
			{notes.length === 0 ? (
				<p>{emptyText}</p>
			) : (
				<ul className="grid gap-2">
					{notes.map((note) => (
						<li key={`${note.at}|${note.text}`}>
							<p className="whitespace-pre-wrap">{note.text}</p>
							<p className="text-base">
								{note.by} · {formatTime(note.at)}
							</p>
						</li>
					))}
				</ul>
			)}
			{onAdd && (
				<form onSubmit={submit} className="grid gap-2 print:hidden">
					<Label htmlFor={id} className="text-base">
						{label}
					</Label>
					<Textarea
						id={id}
						ref={input}
						value={text}
						onChange={(event) => setText(event.currentTarget.value)}
						className="min-h-24 text-base md:text-base"
					/>
					<Submit error={error} label="Add" />
				</form>
			)}
		</>
	);
}
