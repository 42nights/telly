// One visit: when and where in its own time zone, the booking state, the preparation, and the
// actions a member may take. A request is simulated and is never shown as a booking; only the
// provider's own confirmation, recorded by a member, books the visit.
import type {
	Appointment,
	ProviderConfirmation,
} from "@health/contracts/appointments";
import { Button } from "@health/ui/components/button";
import { type ReactNode, useState } from "react";

import { failureText } from "@/components/reports/use-report-sheet";
import { familyPath } from "@/lib/api";

import { buttonClass, fieldClass, type RunAction, useAction } from "./action";

import {
	draftOf,
	formatVisitTime,
	LIST_FIELDS,
	type PrepDraft,
	prepOf,
	REMINDER_CHOICES,
	statusLabel,
} from "./logic";
import { SummaryPanel } from "./summary";

/** The preparation fields, shared by the new-visit form and the edit form. */
export function PrepFields({
	draft,
	onChange,
}: {
	draft: PrepDraft;
	onChange: (draft: PrepDraft) => void;
}) {
	return (
		<>
			<label className="grid gap-1">
				Transportation
				<input
					className={`${fieldClass} h-11`}
					value={draft.transportation}
					placeholder="Not arranged"
					onChange={(e) =>
						onChange({ ...draft, transportation: e.target.value })
					}
				/>
			</label>
			<fieldset className="flex min-w-0 flex-wrap gap-3 border border-border p-2">
				<legend className="px-1">Reminders</legend>
				{REMINDER_CHOICES.map(([minutes, label]) => (
					<label key={minutes} className="flex min-h-11 items-center gap-1.5">
						<input
							type="checkbox"
							className="size-5"
							checked={draft.reminders.includes(minutes)}
							onChange={(e) =>
								onChange({
									...draft,
									reminders: e.target.checked
										? [...draft.reminders, minutes]
										: draft.reminders.filter((m) => m !== minutes),
								})
							}
						/>
						{label}
					</label>
				))}
			</fieldset>
			{LIST_FIELDS.map(([name, label]) => (
				<label key={name} className="grid gap-1">
					{label} (one per line)
					<textarea
						className={`${fieldClass} min-h-16`}
						value={draft[name]}
						onChange={(e) => onChange({ ...draft, [name]: e.target.value })}
					/>
				</label>
			))}
		</>
	);
}

function Facts({ appointment }: { appointment: Appointment }) {
	const { visit, prep } = appointment;
	const starts = Date.parse(visit.startsAt);
	const rows: [string, string][] = [
		["When", formatVisitTime(starts, visit.timeZone)],
		["Time zone", visit.timeZone],
		["Clinician", visit.clinician ?? "Not recorded"],
		["Where", visit.location ?? "Not recorded"],
		["Transportation", prep.transportation ?? "Not arranged"],
		[
			"Reminders",
			prep.reminders.length === 0
				? "None"
				: prep.reminders
						.map((m) => formatVisitTime(starts - m * 60_000, visit.timeZone))
						.join("; "),
		],
	];
	return (
		<dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
			{rows.map(([term, value]) => (
				<div key={term} className="contents">
					<dt className="font-bold">{term}</dt>
					<dd>{value}</dd>
				</div>
			))}
			{LIST_FIELDS.map(([name, label]) => (
				<div key={name} className="contents">
					<dt className="font-bold">{label}</dt>
					<dd>
						{prep[name].length === 0 ? (
							"None recorded"
						) : (
							<ul className="list-disc pl-5">
								{prep[name].map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

/** Every recorded step, so a request never reads as a booking. */
function Steps({ appointment }: { appointment: Appointment }) {
	const { suggestion, request, confirmation, cancellation } = appointment;
	const when = (at: string) => formatVisitTime(at, appointment.visit.timeZone);
	return (
		<ol className="grid gap-0.5 text-xs">
			<li>
				Suggested by{" "}
				{suggestion.source === "model" ? "the assistant" : "a family member"} ·{" "}
				{when(suggestion.at)}
			</li>
			<li>
				{request === null
					? "Not requested"
					: `Requested · ${when(request.at)} · simulated: nothing was sent to the provider`}
			</li>
			<li>
				{confirmation === null
					? "No provider confirmation"
					: `Provider confirmed · reference ${confirmation.reference} · by ${confirmation.receivedVia} · recorded ${when(confirmation.at)}`}
			</li>
			{cancellation !== null && <li>Cancelled · {when(cancellation.at)}</li>}
		</ol>
	);
}

/** A form with one save action and a close button. */
function Panel({
	legend,
	saveLabel,
	canSave,
	onSave,
	onClose,
	children,
}: {
	legend: string;
	saveLabel: string;
	canSave: boolean;
	onSave: () => void;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<fieldset className="grid min-w-0 gap-2 border border-border p-2">
			<legend className="px-1">{legend}</legend>
			{children}
			<div className="flex gap-2">
				<Button
					type="button"
					className={`${buttonClass} win95-primary`}
					disabled={!canSave}
					onClick={onSave}
				>
					{saveLabel}
				</Button>
				<Button type="button" className={buttonClass} onClick={onClose}>
					Close
				</Button>
			</div>
		</fieldset>
	);
}

type PanelProps = {
	appointment: Appointment;
	base: string;
	/** No write is in progress. */
	idle: boolean;
	act: RunAction;
	onClose: () => void;
};

function RequestPanel({ appointment, base, idle, act, onClose }: PanelProps) {
	const [agreed, setAgreed] = useState(false);
	return (
		<Panel
			legend="Request this visit"
			saveLabel="Record request"
			canSave={agreed && idle}
			onSave={() =>
				void act("Recording request…", `${base}/request`, "POST", {
					confirm: true,
				})
			}
			onClose={onClose}
		>
			<p>
				Telly has no scheduling access. This records your request only; nothing
				is sent to {appointment.visit.clinician ?? "the provider"}, and the
				visit is not booked until the provider confirms it.
			</p>
			<label className="flex min-h-11 items-center gap-2">
				<input
					type="checkbox"
					className="size-5"
					checked={agreed}
					onChange={(e) => setAgreed(e.target.checked)}
				/>
				I confirm this visit, time, and place should be requested.
			</label>
		</Panel>
	);
}

function ConfirmPanel({ base, idle, act, onClose }: PanelProps) {
	const [confirmation, setConfirmation] = useState<ProviderConfirmation>({
		reference: "",
		receivedVia: "phone",
	});
	const reference = confirmation.reference.trim();
	return (
		<Panel
			legend="Provider confirmation"
			saveLabel="Save confirmation"
			canSave={reference !== "" && idle}
			onSave={() =>
				void act("Saving…", `${base}/confirmation`, "POST", {
					...confirmation,
					reference,
				})
			}
			onClose={onClose}
		>
			<p>Enter the booking reference the provider gave you.</p>
			<label className="grid gap-1">
				Reference
				<input
					className={`${fieldClass} h-11`}
					value={confirmation.reference}
					onChange={(e) =>
						setConfirmation({ ...confirmation, reference: e.target.value })
					}
				/>
			</label>
			<label className="grid gap-1">
				Received by
				<select
					className={`${fieldClass} h-11`}
					value={confirmation.receivedVia}
					onChange={(e) =>
						setConfirmation({
							...confirmation,
							receivedVia: e.target
								.value as ProviderConfirmation["receivedVia"],
						})
					}
				>
					<option value="phone">Phone</option>
					<option value="email">Email</option>
					<option value="letter">Letter</option>
					<option value="portal">Patient portal</option>
				</select>
			</label>
		</Panel>
	);
}

function PrepPanel({ appointment, base, idle, act, onClose }: PanelProps) {
	const [draft, setDraft] = useState(() => draftOf(appointment.prep));
	return (
		<Panel
			legend="Preparation"
			saveLabel="Save preparation"
			canSave={idle}
			onSave={() => void act("Saving…", `${base}/prep`, "PUT", prepOf(draft))}
			onClose={onClose}
		>
			<PrepFields draft={draft} onChange={setDraft} />
		</Panel>
	);
}

const PANELS = {
	request: RequestPanel,
	confirm: ConfirmPanel,
	prep: PrepPanel,
} as const;
type PanelName = keyof typeof PANELS;
type Opener = readonly [PanelName, string];

/** The next booking step, offered only from the state just before it. */
const NEXT_STEP: Partial<Record<Appointment["status"], Opener>> = {
	suggested: ["request", "Request this visit…"],
	requested: ["confirm", "Record provider confirmation…"],
};
const PREP_STEP: Opener = ["prep", "Edit preparation…"];

export function VisitCard({
	appointment,
	familyId,
	onChanged,
}: {
	appointment: Appointment;
	familyId: string;
	onChanged: () => void;
}) {
	const [panel, setPanel] = useState<PanelName | null>(null);
	const { busy, failure, run } = useAction(onChanged);
	const base = familyPath(
		familyId,
		`/appointments/${encodeURIComponent(appointment.id)}`,
	);
	const open = appointment.status !== "cancelled";
	const act: RunAction = async (...args) => {
		const ok = await run(...args);
		if (ok) setPanel(null);
		return ok;
	};
	const next = NEXT_STEP[appointment.status];
	const openers = next === undefined ? [PREP_STEP] : [next, PREP_STEP];
	const Open = panel === null ? null : PANELS[panel];

	return (
		<article
			aria-label={appointment.visit.title}
			className="win95-raised wrap-anywhere grid min-w-0 gap-2 p-2 text-sm"
		>
			<header className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="font-bold text-base">{appointment.visit.title}</h3>
				<p className="win95-inset px-2 py-0.5 text-xs">
					{statusLabel[appointment.status]}
				</p>
			</header>
			<Facts appointment={appointment} />
			<Steps appointment={appointment} />
			{failure !== null && (
				<p role="alert" className="font-bold">
					{failureText(failure)}
				</p>
			)}
			{open && (
				<div className="flex flex-wrap gap-2">
					{openers.map(([name, label]) => (
						<Button
							key={name}
							type="button"
							className={buttonClass}
							onClick={() => setPanel(name)}
						>
							{label}
						</Button>
					))}
					<Button
						type="button"
						className={buttonClass}
						disabled={busy !== null}
						onClick={() => void act("Cancelling…", `${base}/cancel`, "POST")}
					>
						Cancel visit
					</Button>
				</div>
			)}
			{open && Open !== null && (
				<Open
					appointment={appointment}
					base={base}
					idle={busy === null}
					act={act}
					onClose={() => setPanel(null)}
				/>
			)}
			{busy !== null && <p role="status">{busy}</p>}
			{open && (
				<SummaryPanel
					appointment={appointment}
					base={base}
					onChanged={onChanged}
				/>
			)}
		</article>
	);
}
