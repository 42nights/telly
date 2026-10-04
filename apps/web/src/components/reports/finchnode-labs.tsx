import {
	FinchnodeLabs,
	FinchnodeSession,
	type FinchnodeSubjectLabs,
} from "@health/contracts/reports";
import { Button } from "@health/ui/components/button";
import { useState } from "react";

import { Tip } from "@/components/win95";
import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";

import { DataTable } from "./data-table";
import { demoText, formatTime, labRange, labValue } from "./logic";

type Fetch =
	| { readonly kind: "idle" }
	| { readonly kind: "working"; readonly step: string }
	/** The patient still has to approve sharing at `url`. */
	| {
			readonly kind: "awaiting";
			readonly session: FinchnodeSession;
			readonly url: string | null;
	  }
	| { readonly kind: "done"; readonly labs: FinchnodeLabs; readonly at: number }
	| ApiFailure;

const failureText = (failure: ApiFailure) =>
	failure.kind === "signed_out"
		? "Sign in to fetch health data."
		: `FinchNode is ${failure.kind === "unavailable" ? "unavailable" : "not reachable"}: ${failure.message}`;

const ACCESS_TEXT = {
	inactive: "The patient turned off sharing. No results are shown.",
	not_granted: "The patient's sharing does not include lab results.",
} as const;

/** Reads lab results from FinchNode with the patient's consent. Values are shown as the source sent them. */
export function FinchnodeLabsPanel({ familyId }: { familyId: string }) {
	const [fetch, setFetch] = useState<Fetch>({ kind: "idle" });

	/**
	 * Shows the linked subjects' labs. With `orConnect`, a family without a subject that still shares
	 * starts FinchNode Connect instead, so a finished Connect is not asked for again.
	 */
	const readLabs = async (orConnect = false): Promise<void> => {
		setFetch({ kind: "working", step: "Reading lab results…" });
		const labs = await apiRequest(
			FinchnodeLabs,
			familyPath(familyId, "/finchnode/labs"),
		);
		if (labs.kind !== "ready") {
			setFetch(labs);
			return;
		}
		if (
			orConnect &&
			!labs.value.subjects.some((subject) => subject.access === "granted")
		)
			return connect();
		const demo = labs.value.subjects.filter((s) => s.synthetic).length;
		if (demo > 0)
			console.error(
				`FinchNode sent demo records for ${demo} subject(s). They are not real patient data.`,
			);
		setFetch({ kind: "done", labs: labs.value, at: Date.now() });
	};

	const connect = async (): Promise<void> => {
		setFetch({ kind: "working", step: "Starting a FinchNode session…" });
		const session = await apiRequest(
			FinchnodeSession,
			familyPath(familyId, "/finchnode/sessions"),
			{ method: "POST" },
		);
		if (session.kind !== "ready") return setFetch(session);
		if (session.value.url !== null)
			window.open(session.value.url, "_blank", "noopener");
		if (session.value.linked) return readLabs();
		setFetch({
			kind: "awaiting",
			session: session.value,
			url: session.value.url,
		});
	};

	const checkLink = async (session: FinchnodeSession, url: string | null) => {
		setFetch({ kind: "working", step: "Checking sharing…" });
		const linked = await apiRequest(
			FinchnodeSession,
			familyPath(
				familyId,
				`/finchnode/sessions/${encodeURIComponent(session.sessionId)}/link`,
			),
			{ method: "POST" },
		);
		if (linked.kind !== "ready") return setFetch(linked);
		if (linked.value.linked) return readLabs();
		setFetch({ kind: "awaiting", session: linked.value, url });
	};

	return (
		<div className="grid gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					className="h-11 px-3 text-sm"
					disabled={fetch.kind === "working"}
					onClick={() => void readLabs(true)}
				>
					Fetch health data from Finchnode
				</Button>
				<span className="flex items-center gap-1 text-sm">
					Last fetch: {fetch.kind === "done" ? formatTime(fetch.at) : "not yet"}
					<Tip text="Finchnode data access is not verified for production yet." />
				</span>
			</div>
			<div role="status" className="text-sm">
				{fetch.kind === "working" && fetch.step}
				{fetch.kind === "awaiting" && (
					<span className="flex flex-wrap items-center gap-2">
						Approve sharing in FinchNode
						{fetch.url !== null && (
							<a
								href={fetch.url}
								target="_blank"
								rel="noopener noreferrer"
								className="underline"
							>
								(open FinchNode Connect)
							</a>
						)}
						, then check again.
						<Button
							type="button"
							className="h-11 px-3 text-sm"
							onClick={() => void checkLink(fetch.session, fetch.url)}
						>
							Check sharing
						</Button>
					</span>
				)}
			</div>
			{(fetch.kind === "signed_out" ||
				fetch.kind === "forbidden" ||
				fetch.kind === "unavailable" ||
				fetch.kind === "error") && (
				<p role="alert" className="win95-inset bg-card p-2 text-sm">
					{failureText(fetch)}
				</p>
			)}
			{fetch.kind === "done" &&
				(fetch.labs.subjects.length === 0 ? (
					<p className="win95-inset bg-card p-2 text-sm">
						No patient is linked to FinchNode yet. No lab results.
					</p>
				) : (
					fetch.labs.subjects.map((subject) => (
						<SubjectLabs key={subject.subject} subject={subject} />
					))
				))}
		</div>
	);
}

function SubjectLabs({ subject }: { subject: FinchnodeSubjectLabs }) {
	const say = (text: string) => (subject.synthetic ? demoText(text) : text);
	return (
		<fieldset className="grid gap-1.5 border border-border p-2 text-sm">
			<legend className="px-1">
				FinchNode lab results
				{subject.synthetic && (
					<b className="ml-2 bg-[#ffffe1] px-1 text-black">
						FinchNode demo data
					</b>
				)}
			</legend>
			<p>
				{subject.syncStatus !== null && `Sync: ${say(subject.syncStatus)}. `}
				{subject.dataAsOf !== null &&
					`Data as of ${formatTime(subject.dataAsOf)}. `}
				{subject.sources.length > 0 &&
					`From ${subject.sources.map((source) => say(source.organization ?? source.system)).join(", ")}.`}
			</p>
			{subject.warnings.length > 0 && (
				<p role="alert">
					FinchNode warnings: {subject.warnings.map(say).join(", ")}
				</p>
			)}
			{subject.access !== "granted" ? (
				<p className="win95-inset bg-card p-2">{ACCESS_TEXT[subject.access]}</p>
			) : subject.labs.length === 0 ? (
				<p className="win95-inset bg-card p-2">
					The source has no lab results.
				</p>
			) : (
				<DataTable
					headers={["Test", "Value", "Date", "Source range", "Source"]}
				>
					{subject.labs.map((lab) => (
						<tr key={lab.id} className="border-border border-t align-top">
							<td className="p-1.5">
								{say(lab.name)}
								{lab.interpretation !== null && (
									<small className="block text-sm">
										Source says: {say(lab.interpretation)}
									</small>
								)}
							</td>
							<td className="p-1.5">{labValue(lab)}</td>
							<td className="p-1.5">
								{lab.date === null ? "Not dated" : formatTime(lab.date)}
							</td>
							<td className="p-1.5">{say(labRange(lab) ?? "—")}</td>
							<td className="p-1.5">
								{say(lab.sourceName ?? lab.source ?? "Not named")}
							</td>
						</tr>
					))}
				</DataTable>
			)}
		</fieldset>
	);
}
