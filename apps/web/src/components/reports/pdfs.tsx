import { type Report, ReportPdf, ReportPdfs } from "@health/contracts/reports";
import { Button } from "@health/ui/components/button";
import { useState } from "react";

import { ApiNotice } from "@/components/win95";
import {
	type ApiFailure,
	apiBlob,
	apiRequest,
	familyPath,
	useApi,
} from "@/lib/api";

import { DataTable } from "./data-table";
import { formatTime } from "./logic";
import { failureText } from "./use-report-sheet";

/**
 * The Save as PDF and Past PDFs buttons, for a row beside Send. A PDF is kept in the caller's
 * private storage; saving one sends nothing.
 */
export function PdfActions({
	familyId,
	reportId,
	reports,
}: {
	familyId: string;
	reportId: string;
	reports: readonly Report[];
}) {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const [open, setOpen] = useState(false);

	const save = async () => {
		setBusy(true);
		const saved = await apiRequest(
			ReportPdf,
			familyPath(familyId, `/reports/${encodeURIComponent(reportId)}/pdfs`),
			{ method: "POST" },
		);
		setBusy(false);
		setResult(
			saved.kind === "ready"
				? `PDF saved ${formatTime(saved.value.createdAt)}. Only you can open it.`
				: `PDF not saved: ${failureText(saved)}`,
		);
	};

	return (
		<>
			<Button
				type="button"
				className="h-11 px-4 text-sm"
				disabled={busy}
				onClick={() => void save()}
			>
				{busy ? "Saving PDF…" : "Save as PDF"}
			</Button>
			<Button
				type="button"
				className="h-11 px-4 text-sm"
				onClick={() => setOpen(true)}
			>
				Past PDFs…
			</Button>
			<p role="status" className="basis-full">
				{result ?? "Saving a PDF does not send it to anyone."}
			</p>
			{open && (
				<PastPdfsDialog
					familyId={familyId}
					reports={reports}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

function PastPdfsDialog({
	familyId,
	reports,
	onClose,
}: {
	familyId: string;
	reports: readonly Report[];
	onClose: () => void;
}) {
	const state = useApi(ReportPdfs, familyPath(familyId, "/report-pdfs"));
	const [failure, setFailure] = useState<ApiFailure | null>(null);

	const download = async (id: string) => {
		const file = await apiBlob(
			familyPath(familyId, `/report-pdfs/${encodeURIComponent(id)}`),
			{ method: "GET" },
		);
		if (file.kind !== "ready") return setFailure(file);
		setFailure(null);
		const url = URL.createObjectURL(file.value);
		const link = document.createElement("a");
		link.href = url;
		link.download = `lab-report-${id.slice(0, 8)}.pdf`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	};

	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-3">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="report-pdfs-title"
				onKeyDown={(event) => event.key === "Escape" && onClose()}
				className="win95-raised w-full max-w-lg"
			>
				<h3 id="report-pdfs-title" className="win95-titlebar px-2 py-1 text-sm">
					Past PDFs
				</h3>
				<div className="grid gap-3 p-3 text-sm">
					{state.kind !== "ready" ? (
						<ApiNotice state={state} what="past PDFs" />
					) : state.value.pdfs.length === 0 ? (
						<p>You have not saved a PDF of a report in this family.</p>
					) : (
						<DataTable headers={["Saved", "Of the report from", "Size", ""]}>
							{state.value.pdfs.map((pdf) => {
								const of = reports.find((r) => r.id === pdf.reportId);
								return (
									<tr key={pdf.id} className="border-border border-t">
										<td className="p-1.5">{formatTime(pdf.createdAt)}</td>
										<td className="p-1.5">
											{of === undefined ? "—" : formatTime(of.createdAt)}
										</td>
										<td className="p-1.5">{Math.ceil(pdf.bytes / 1024)} KB</td>
										<td className="p-1.5">
											<Button
												type="button"
												className="h-11 px-3 text-sm"
												onClick={() => void download(pdf.id)}
											>
												Download
											</Button>
										</td>
									</tr>
								);
							})}
						</DataTable>
					)}
					{failure !== null && (
						<p role="alert">Not downloaded: {failureText(failure)}</p>
					)}
					<p>Only you can see these PDFs. They are not sent to anyone.</p>
					<Button
						type="button"
						className="h-11 justify-self-end px-4 text-sm"
						autoFocus
						onClick={onClose}
					>
						Close
					</Button>
				</div>
			</div>
		</div>
	);
}
