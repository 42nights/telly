import { Report, Reports } from "@health/contracts/reports";
import { Button } from "@health/ui/components/button";
import { FileText } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Window } from "@/components/hud/window";
import { ApiNotice } from "@/components/win95";
import { type ApiFailure, apiRequest, familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

import { formatTime } from "./logic";
import {
	MarkersTab,
	NotesTab,
	PatientTab,
	SendDialog,
	SendTab,
} from "./report-tabs";
import { failureText, useReportSheet } from "./use-report-sheet";

const TABS = ["Patient", "Markers", "Notes", "Send"] as const;
type Tab = (typeof TABS)[number];

/** Lab report, variation B: a tabbed property sheet. Hospital delivery is unavailable on the server. */
export function ReportScreen() {
	const { state, family } = useFamily();
	if (family === null)
		return (
			<Frame status="No report">
				<ApiNotice
					state={
						state.kind === "ready"
							? { kind: "error", message: "No person is paired yet." }
							: state
					}
					what="reports"
				/>
			</Frame>
		);
	return <FamilyReports familyId={family.id} familyName={family.name} />;
}

/** The selected family's reports: the newest, or the one picked, and a way to create one. */
function FamilyReports({
	familyId,
	familyName,
}: {
	familyId: string;
	familyName: string;
}) {
	const [refreshKey, setRefreshKey] = useState(0);
	const [selected, setSelected] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<ApiFailure | null>(null);
	const state = useApi(Reports, familyPath(familyId, "/reports"), {
		refreshKey,
	});

	if (state.kind !== "ready")
		return (
			<Frame status="No report">
				<ApiNotice state={state} what="reports" />
			</Frame>
		);

	const create = async () => {
		setBusy(true);
		const created = await apiRequest(Report, familyPath(familyId, "/reports"), {
			method: "POST",
		});
		setBusy(false);
		if (created.kind !== "ready") return setFailure(created);
		setFailure(null);
		setSelected(created.value.id);
		setRefreshKey((key) => key + 1);
	};

	const { reports } = state.value;
	const report = reports.find((item) => item.id === selected) ?? reports[0];
	const createButton = (primary: boolean) => (
		<Button
			type="button"
			className={`h-11 px-3 text-sm ${primary ? "win95-primary" : ""}`}
			disabled={busy}
			onClick={() => void create()}
		>
			{busy ? "Creating…" : "New report"}
		</Button>
	);

	if (report === undefined)
		return (
			<Frame
				status={failure === null ? "No reports yet" : failureText(failure)}
			>
				<div className="grid justify-items-start gap-3 p-3 text-sm">
					<p>
						No reports yet. A new report collects the latest reading of each
						measure saved for {familyName}.
					</p>
					{createButton(true)}
				</div>
			</Frame>
		);

	return (
		<ReportSheet
			key={`${report.id}:${report.review === null ? "draft" : "reviewed"}`}
			report={report}
			reports={reports}
			familyId={familyId}
			onSelect={setSelected}
			onChanged={() => setRefreshKey((key) => key + 1)}
			createButton={createButton(false)}
			createFailure={failure}
		/>
	);
}

function Frame({ status, children }: { status: string; children: ReactNode }) {
	return (
		<Window title="Lab report properties" icon={FileText} status={status}>
			{children}
		</Window>
	);
}

function ReportHeader({
	report,
	reports,
	onSelect,
	createButton,
}: {
	report: Report;
	reports: readonly Report[];
	onSelect: (id: string) => void;
	createButton: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-2">
			<h2 className="font-bold text-base">
				Lab report · {report.fields.patientName ?? "Patient not named"}
				{report.markers.some((m) => m.sample?.synthetic) && (
					<span className="win95-inset ml-2 bg-card px-1.5 py-0.5 font-bold text-sm">
						Demo data
					</span>
				)}
			</h2>
			<div className="flex flex-wrap items-center gap-2">
				{reports.length > 1 && (
					<label className="flex items-center gap-1.5">
						Report
						<select
							className="win95-inset win95-field h-11 bg-card px-2 text-sm"
							value={report.id}
							onChange={(event) => onSelect(event.target.value)}
						>
							{reports.map((item) => (
								<option key={item.id} value={item.id}>
									{formatTime(item.createdAt)}
									{item.review === null ? " · draft" : " · reviewed"}
								</option>
							))}
						</select>
					</label>
				)}
				{createButton}
			</div>
		</div>
	);
}

function TabStrip({
	tab,
	onSelect,
}: {
	tab: Tab;
	onSelect: (tab: Tab) => void;
}) {
	return (
		<div role="tablist" aria-label="Report sections" className="flex flex-wrap">
			{TABS.map((name) => (
				<button
					key={name}
					type="button"
					role="tab"
					id={`report-tab-${name}`}
					aria-selected={tab === name}
					aria-controls="report-tab-panel"
					className={`win95-raised min-h-11 px-4 text-sm ${tab === name ? "relative z-10 -mb-px font-bold" : "mt-1"}`}
					onClick={() => onSelect(name)}
				>
					{name}
				</button>
			))}
		</div>
	);
}

function ReportSheet({
	report,
	reports,
	familyId,
	onSelect,
	onChanged,
	createButton,
	createFailure,
}: {
	report: Report;
	reports: readonly Report[];
	familyId: string;
	onSelect: (id: string) => void;
	onChanged: () => void;
	createButton: ReactNode;
	createFailure: ApiFailure | null;
}) {
	const sheet = useReportSheet(report, familyId, onChanged, createFailure);
	const [tab, setTab] = useState<Tab>(sheet.reviewed ? "Send" : "Patient");
	const [asking, setAsking] = useState(false);

	return (
		<Frame status={sheet.status}>
			<div className="grid gap-3 p-1 text-sm">
				<ReportHeader
					report={report}
					reports={reports}
					onSelect={onSelect}
					createButton={createButton}
				/>
				<TabStrip tab={tab} onSelect={setTab} />
				<div
					role="tabpanel"
					id="report-tab-panel"
					aria-labelledby={`report-tab-${tab}`}
					className="win95-raised grid gap-3 p-3"
				>
					{tab === "Patient" && <PatientTab sheet={sheet} report={report} />}
					{tab === "Markers" && (
						<MarkersTab report={report} familyId={familyId} sheet={sheet} />
					)}
					{tab === "Notes" && <NotesTab sheet={sheet} />}
					{tab === "Send" && (
						<SendTab
							sheet={sheet}
							report={report}
							reports={reports}
							familyId={familyId}
							onAsk={() => setAsking(true)}
						/>
					)}
				</div>
			</div>
			{asking && (
				<SendDialog
					hospital={report.fields.hospital}
					onSend={() => {
						setAsking(false);
						void sheet.submit();
					}}
					onCancel={() => setAsking(false)}
				/>
			)}
		</Frame>
	);
}
