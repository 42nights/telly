// The visit summary and clinician updates. A member reads the generated summary, marks it reviewed,
// then approves who receives which sections, how often. Delivery is simulated: Telly has no approved
// clinician channel, a send is not a read receipt, and routine updates are not emergency monitoring.
import {
	type Appointment,
	type ClinicianShare,
	ClinicianShares,
	type NewClinicianShare,
	PrepSummary,
	type SummarySection,
} from "@health/contracts/appointments";
import { Button } from "@health/ui/components/button";
import { useState } from "react";

import { failureText } from "@/components/reports/use-report-sheet";
import { type ApiFailure, apiRequest, useApi } from "@/lib/api";

import { buttonClass, fieldClass, type RunAction, useAction } from "./action";
import { formatVisitTime, LIST_FIELDS } from "./logic";

const SECTIONS: readonly (readonly [SummarySection, string])[] = [
	["labs", "Dated lab results"],
	["observations", "Observations from the reviewed lab report"],
	...LIST_FIELDS,
];
const sectionLabel = Object.fromEntries(SECTIONS) as Record<
	SummarySection,
	string
>;

const CONSENTS = {
	once: { kind: "explicit", frequency: "once" },
	weekly: { kind: "standing", frequency: "weekly" },
	monthly: { kind: "standing", frequency: "monthly" },
} as const satisfies Record<string, NewClinicianShare["consent"]>;

const consentText = {
	once: "Once: I approve one send of this summary as reviewed",
	weekly: "Standing: the latest reviewed summary, at most weekly",
	monthly: "Standing: the latest reviewed summary, at most monthly",
} as const;

function SummaryView({ summary }: { summary: PrepSummary }) {
	return (
		<div className="grid gap-2">
			<section>
				<h4 className="font-bold">Lab results</h4>
				{summary.labs === null ? (
					<p>Unavailable: no linked Finchnode records with granted access.</p>
				) : (
					<ul className="list-disc pl-5">
						{summary.labs.map((lab) => (
							<li key={lab.id}>
								{lab.name}: {lab.value ?? "no value"} {lab.unit ?? ""} ·{" "}
								{lab.date ?? "undated"} ·{" "}
								{lab.sourceName ?? lab.source ?? "source unknown"}
							</li>
						))}
					</ul>
				)}
			</section>
			<section>
				<h4 className="font-bold">Observations</h4>
				{summary.observations === null ? (
					<p>Unavailable: no reviewed lab report.</p>
				) : (
					<ul className="list-disc pl-5">
						{summary.observations.markers.map(({ metric, sample }) => (
							<li key={metric}>
								{metric}:{" "}
								{sample === null
									? "unavailable"
									: `${sample.value} ${sample.unit} · ${sample.sourceTime} · ${sample.quality}`}
							</li>
						))}
					</ul>
				)}
			</section>
			{LIST_FIELDS.map(([name, label]) => (
				<section key={name}>
					<h4 className="font-bold">{label}</h4>
					<p>
						{summary[name].length === 0
							? "None recorded"
							: summary[name].join("; ")}
					</p>
				</section>
			))}
		</div>
	);
}

/** Read the generated summary, then mark it reviewed; or show the summary already reviewed. */
function SummaryReview({
	appointment,
	base,
	idle,
	run,
}: {
	appointment: Appointment;
	base: string;
	idle: boolean;
	run: RunAction;
}) {
	const [draft, setDraft] = useState<PrepSummary | null>(null);
	const [readFailure, setReadFailure] = useState<ApiFailure | null>(null);
	const reviewed = appointment.summary;

	const prepare = async () => {
		const result = await apiRequest(PrepSummary, `${base}/summary`);
		if (result.kind !== "ready") return setReadFailure(result);
		setReadFailure(null);
		setDraft(result.value);
	};
	const review = async (seen: PrepSummary) => {
		if (await run("Saving review…", `${base}/summary`, "POST", seen))
			setDraft(null);
	};

	return (
		<>
			<p>
				{reviewed === null
					? "Summary not reviewed. Nothing can be shared yet."
					: `Summary reviewed ${formatVisitTime(reviewed.at, appointment.visit.timeZone)}.`}
			</p>
			{draft === null ? (
				<Button
					type="button"
					className={`${buttonClass} justify-self-start`}
					onClick={() => void prepare()}
				>
					{reviewed === null ? "Prepare summary…" : "Prepare a new summary…"}
				</Button>
			) : (
				<div className="win95-inset grid gap-2 bg-card p-2">
					<SummaryView summary={draft} />
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							className={`${buttonClass} win95-primary`}
							disabled={!idle}
							onClick={() => void review(draft)}
						>
							I reviewed this summary
						</Button>
						<Button
							type="button"
							className={buttonClass}
							onClick={() => setDraft(null)}
						>
							Close
						</Button>
					</div>
				</div>
			)}
			{readFailure !== null && (
				<p role="alert" className="font-bold">
					{failureText(readFailure)}
				</p>
			)}
			{reviewed !== null && draft === null && (
				<details>
					<summary className="min-h-11 cursor-pointer py-2">
						Show the reviewed summary
					</summary>
					<SummaryView summary={reviewed.content} />
				</details>
			)}
		</>
	);
}

export function SummaryPanel({
	appointment,
	base,
}: {
	appointment: Appointment;
	base: string;
}) {
	const { busy, failure, run } = useAction();
	const shares = useApi(ClinicianShares, `${base}/shares`);
	const reviewed = appointment.summary;
	const zone = appointment.visit.timeZone;

	return (
		<fieldset className="grid min-w-0 gap-2 border border-border p-2">
			<legend className="px-1">Visit summary and clinician updates</legend>
			<SummaryReview
				appointment={appointment}
				base={base}
				idle={busy === null}
				run={run}
			/>
			<p className="text-xs">
				Clinician updates are simulated: Telly has no approved clinician
				channel. Sent does not mean read. Routine updates are not emergency
				monitoring.
			</p>
			{busy !== null && <p role="status">{busy}</p>}
			{failure !== null && (
				<p role="alert" className="font-bold">
					{failureText(failure)}
				</p>
			)}
			{shares.kind === "ready" ? (
				<ul className="grid gap-2">
					{shares.value.shares.map((share) => (
						<ShareItem
							key={share.id}
							share={share}
							base={base}
							zone={zone}
							idle={busy === null}
							run={run}
						/>
					))}
				</ul>
			) : (
				shares.kind !== "loading" && (
					<p role="alert">Updates unavailable: {failureText(shares)}</p>
				)
			)}
			{reviewed !== null && <NewShare base={base} busy={busy} run={run} />}
		</fieldset>
	);
}

/** One consent: who receives which sections how often, and its simulated sends. */
function ShareItem({
	share,
	base,
	zone,
	idle,
	run,
}: {
	share: ClinicianShare;
	base: string;
	zone: string;
	idle: boolean;
	run: RunAction;
}) {
	const path = `${base}/shares/${encodeURIComponent(share.id)}`;
	const active = share.revocation === null;
	const due =
		share.nextSendAt !== null && Date.parse(share.nextSendAt) <= Date.now();
	const sent =
		share.lastSentAt === null
			? "Not sent"
			: `Sent ${share.sends}× (simulated) · last ${formatVisitTime(share.lastSentAt, zone)} · not known to be read`;
	const next =
		share.nextSendAt !== null && !due
			? ` · next allowed ${formatVisitTime(share.nextSendAt, zone)}`
			: "";
	return (
		<li className="win95-inset grid gap-1 bg-card p-2">
			<p className="font-bold">
				To {share.recipient.name}
				{share.recipient.role === null ? "" : ` (${share.recipient.role})`} ·{" "}
				{share.recipient.address}
			</p>
			<p>
				{consentText[share.consent.frequency]} · sections:{" "}
				{share.sections.map((s) => sectionLabel[s]).join(", ")}
			</p>
			<p>{active ? `${sent}${next}` : "Revoked"}</p>
			{active && (
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						className={buttonClass}
						disabled={!due || !idle}
						onClick={() =>
							void run("Sending (simulated)…", `${path}/send`, "POST")
						}
					>
						Send (simulated)
					</Button>
					<Button
						type="button"
						className={buttonClass}
						disabled={!idle}
						onClick={() => void run("Revoking…", `${path}/revoke`, "POST")}
					>
						Revoke consent
					</Button>
				</div>
			)}
		</li>
	);
}

function NewShare({
	base,
	busy,
	run,
}: {
	base: string;
	busy: string | null;
	run: RunAction;
}) {
	const [recipient, setRecipient] = useState({
		name: "",
		role: "",
		address: "",
	});
	const [sections, setSections] = useState<readonly SummarySection[]>([]);
	const [consent, setConsent] = useState<keyof typeof CONSENTS>("once");
	const [agreed, setAgreed] = useState(false);
	const ready =
		recipient.name.trim() !== "" &&
		recipient.address.trim() !== "" &&
		sections.length > 0 &&
		agreed;
	const approve = async () => {
		const body: NewClinicianShare = {
			recipient: {
				name: recipient.name.trim(),
				role: recipient.role.trim() || null,
				address: recipient.address.trim(),
			},
			sections,
			consent: CONSENTS[consent],
		};
		if (await run("Saving consent…", `${base}/shares`, "POST", body)) {
			setAgreed(false);
			setSections([]);
		}
	};
	return (
		<fieldset className="grid min-w-0 gap-2 border border-border p-2">
			<legend className="px-1">Approve a clinician update</legend>
			<p>
				Needs the “Send to clinicians” access on the Care plan screen, and your
				approval for this recipient, these sections, and this frequency.
			</p>
			{(["name", "role", "address"] as const).map((field) => (
				<label key={field} className="grid gap-1">
					{
						{
							name: "Recipient name",
							role: "Role (optional)",
							address: "Email or address",
						}[field]
					}
					<input
						className={`${fieldClass} h-11`}
						value={recipient[field]}
						onChange={(e) =>
							setRecipient({ ...recipient, [field]: e.target.value })
						}
					/>
				</label>
			))}
			<fieldset className="grid min-w-0 gap-1 border border-border p-2">
				<legend className="px-1">Contents</legend>
				{SECTIONS.map(([section, label]) => (
					<label key={section} className="flex min-h-11 items-center gap-2">
						<input
							type="checkbox"
							className="size-5"
							checked={sections.includes(section)}
							onChange={(e) =>
								setSections(
									e.target.checked
										? [...sections, section]
										: sections.filter((s) => s !== section),
								)
							}
						/>
						{label}
					</label>
				))}
			</fieldset>
			<label className="grid gap-1">
				Delivery frequency
				<select
					className={`${fieldClass} h-11`}
					value={consent}
					onChange={(e) => setConsent(e.target.value as keyof typeof CONSENTS)}
				>
					{(Object.keys(CONSENTS) as (keyof typeof CONSENTS)[]).map((key) => (
						<option key={key} value={key}>
							{consentText[key]}
						</option>
					))}
				</select>
			</label>
			<label className="flex min-h-11 items-center gap-2">
				<input
					type="checkbox"
					className="size-5"
					checked={agreed}
					onChange={(e) => setAgreed(e.target.checked)}
				/>
				I approve sending the chosen sections to this recipient at this
				frequency.
			</label>
			<Button
				type="button"
				className={`${buttonClass} win95-primary justify-self-start`}
				disabled={!ready || busy !== null}
				onClick={() => void approve()}
			>
				Approve update
			</Button>
		</fieldset>
	);
}
