import {
	type CareInstruction,
	type CareVerification,
	NewCareInstruction,
} from "@health/contracts/care-profile";
import { Button } from "@health/ui/components/button";
import { Exit, Schema } from "effect";
import { Pill } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { Tip } from "@/components/win95";
import { memberLabel } from "@/lib/members";

import type { CareData } from "./data";

const badge: Record<CareVerification, string> = {
	verified: "Verified · in effect",
	unverified: "Not verified · not read to the wearer",
	conflicting: "Change not verified · the verified version stays in effect",
	stale: "Replaced by a later verified version",
};

const when = (iso: string) => new Date(iso).toLocaleString();

function Instruction({
	item,
	me,
	canEdit,
	verify,
}: {
	item: CareInstruction;
	me: string | null;
	canEdit: boolean;
	verify: (id: string) => void;
}) {
	return (
		<li
			className={`win95-inset grid gap-1 bg-card p-2 ${item.verification === "stale" ? "opacity-70" : ""}`}
		>
			<b>
				{item.name} <small>({item.kind})</small>
			</b>
			<q>{item.instruction}</q>
			<span>
				Times: {item.times.length === 0 ? "none set" : item.times.join(", ")} (
				{item.timeZone ?? "time zone unknown"})
			</span>
			<span>Reason: {item.reason ?? "unknown"}</span>
			<span>
				Source: {item.source}, effective {item.effectiveDate}
			</span>
			<small>
				Entered by {memberLabel(item.editedBy, me)} on {when(item.editedAt)}
				{item.verifiedBy !== null &&
					item.verifiedAt !== null &&
					` · verified by ${memberLabel(item.verifiedBy, me)} on ${when(item.verifiedAt)}`}
			</small>
			<span className="font-bold">{badge[item.verification]}</span>
			{canEdit &&
				(item.verification === "unverified" ||
					item.verification === "conflicting") && (
					<Button
						type="button"
						className="h-11 justify-self-start px-4 text-sm"
						onClick={() => verify(item.id)}
					>
						Verify against the source
					</Button>
				)}
		</li>
	);
}

const empty = {
	kind: "medication",
	name: "",
	instruction: "",
	times: "",
	reason: "",
	source: "",
	effectiveDate: "",
};

function AddInstruction({ write }: { write: CareData["write"] }) {
	const [form, setForm] = useState(empty);
	const [message, setMessage] = useState<string | null>(null);
	const decoded = Schema.decodeUnknownExit(NewCareInstruction)({
		kind: form.kind,
		name: form.name.trim(),
		instruction: form.instruction.trim(),
		times: form.times
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t !== ""),
		reason: form.reason.trim() === "" ? null : form.reason.trim(),
		source: form.source.trim(),
		effectiveDate: form.effectiveDate,
	});
	const field = (key: keyof typeof empty, label: string, hint?: string) => (
		<div className="grid gap-1">
			<label htmlFor={`instruction-${key}`} className="font-bold">
				{label}
			</label>
			<input
				id={`instruction-${key}`}
				type={key === "effectiveDate" ? "date" : "text"}
				className="win95-inset win95-field h-11 w-full bg-card px-2"
				value={form[key]}
				aria-describedby={
					hint === undefined ? undefined : `instruction-${key}-hint`
				}
				onChange={(event) => setForm({ ...form, [key]: event.target.value })}
			/>
			{hint !== undefined && (
				<small id={`instruction-${key}-hint`}>{hint}</small>
			)}
		</div>
	);
	return (
		<form
			aria-label="Add an instruction"
			className="grid gap-2 border border-border p-2"
			onSubmit={async (event) => {
				event.preventDefault();
				if (Exit.isFailure(decoded)) return;
				setMessage("Saving…");
				const refused = await write(
					"POST",
					"/care-instructions",
					decoded.value,
				);
				if (refused === null) setForm(empty);
				setMessage(
					refused ?? "Saved as not verified. Verify it against its source.",
				);
			}}
		>
			<b>Add an instruction or a change</b>
			<div className="grid gap-1">
				<label htmlFor="instruction-kind" className="font-bold">
					Kind
				</label>
				<select
					id="instruction-kind"
					className="win95-inset win95-field h-11 bg-card px-2"
					value={form.kind}
					onChange={(event) => setForm({ ...form, kind: event.target.value })}
				>
					<option value="medication">Medication</option>
					<option value="care">Care instruction</option>
				</select>
			</div>
			{field("name", "Name as written on the source")}
			{field("instruction", "Dose and directions, word for word")}
			{field("times", "Times", "HH:MM, separated by commas.")}
			{field("reason", "Reason", "Leave empty when the source does not say.")}
			{field("source", "Source", "For example pharmacy label.")}
			{field("effectiveDate", "Effective date")}
			{message !== null && <p role="status">{message}</p>}
			<Button
				type="submit"
				className="win95-primary h-11 justify-self-end px-6 text-sm"
				disabled={Exit.isFailure(decoded)}
			>
				Add
			</Button>
		</form>
	);
}

/** Medication and care instructions with their source, editor, and verification. */
export function InstructionsWindow({
	instructions,
	canEdit,
	care,
}: {
	instructions: readonly CareInstruction[];
	canEdit: boolean;
	care: CareData;
}) {
	const [message, setMessage] = useState<string | null>(null);
	const verify = async (id: string) => {
		const refused = await care.write("POST", `/care-instructions/${id}/verify`);
		setMessage(refused ?? "Verified.");
	};
	return (
		<Window
			group
			title="Medicines and care instructions"
			icon={Pill}
			status={message ?? undefined}
		>
			<div className="grid gap-2 p-2 text-sm">
				{instructions.length === 0 ? (
					<p className="flex items-center gap-1">
						No instructions saved. Medicines are unknown.
						<Tip text="Only verified instructions are read to the wearer. A change waits for verification." />
					</p>
				) : (
					<ul className="grid gap-2">
						{instructions.map((item) => (
							<Instruction
								key={item.id}
								item={item}
								me={care.me}
								canEdit={canEdit}
								verify={verify}
							/>
						))}
					</ul>
				)}
				{canEdit && <AddInstruction write={care.write} />}
			</div>
		</Window>
	);
}
