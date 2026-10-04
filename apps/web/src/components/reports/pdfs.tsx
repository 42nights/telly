import {
	type Report,
	ReportPdf,
	ReportPdfLink,
	ReportPdfs,
} from "@health/contracts/reports";
import { Button, buttonVariants } from "@health/ui/components/button";
import { useEffect, useState } from "react";

import { ApiNotice, Tip } from "@/components/win95";
import {
	type ApiFailure,
	type ApiResult,
	apiBlob,
	apiRequest,
	familyPath,
	useApi,
} from "@/lib/api";

import { DataTable } from "./data-table";
import { formatTime } from "./logic";
import { failureText } from "./use-report-sheet";

/**
 * The Preview PDF, Save as PDF, and Past PDFs buttons, for a row beside Send. A PDF is kept in the
 * caller's private storage; saving or previewing one sends nothing.
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
	const [previewing, setPreviewing] = useState(false);

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
				onClick={() => setPreviewing(true)}
			>
				Preview PDF
			</Button>
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
			<Tip text="Saving a PDF does not send it to anyone." />
			<p role="status" className="basis-full">
				{result}
			</p>
			{open && (
				<PastPdfsDialog
					familyId={familyId}
					reports={reports}
					onClose={() => setOpen(false)}
				/>
			)}
			{previewing && (
				<PreviewDialog
					familyId={familyId}
					reportId={reportId}
					onClose={() => setPreviewing(false)}
				/>
			)}
		</>
	);
}

/**
 * The PDF that an email of the report attaches, fetched with the caller's sign-in and shown from
 * memory. Phones have no inline PDF viewer that shows every page, so they get only the buttons.
 */
function PreviewDialog({
	familyId,
	reportId,
	onClose,
}: {
	familyId: string;
	reportId: string;
	onClose: () => void;
}) {
	const [pdf, setPdf] = useState<ApiResult<string> | null>(null);
	useEffect(() => {
		let url: string | undefined;
		let live = true;
		void apiBlob(
			familyPath(familyId, `/reports/${encodeURIComponent(reportId)}/pdf`),
			{ method: "GET" },
		).then((result) => {
			if (!live) return;
			if (result.kind !== "ready") return setPdf(result);
			url = URL.createObjectURL(result.value);
			setPdf({ kind: "ready", value: url });
		});
		return () => {
			live = false;
			if (url !== undefined) URL.revokeObjectURL(url);
		};
	}, [familyId, reportId]);
	const link = `${buttonVariants()} h-11 px-4 text-sm`;

	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-3">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="report-preview-title"
				onKeyDown={(event) => event.key === "Escape" && onClose()}
				className="win95-raised flex max-h-full w-full max-w-4xl flex-col"
			>
				<h3
					id="report-preview-title"
					className="win95-titlebar px-2 py-1 text-sm"
				>
					Preview PDF
				</h3>
				<div className="grid min-h-0 gap-3 p-3 text-sm">
					{pdf === null ? (
						<p role="status">Making the PDF…</p>
					) : pdf.kind !== "ready" ? (
						<p role="alert">Not previewed: {failureText(pdf)}</p>
					) : (
						<iframe
							title="Lab report PDF"
							src={pdf.value}
							className="hidden h-[70dvh] w-full border border-border bg-white md:block"
						/>
					)}
					<div className="flex flex-wrap justify-end gap-2">
						{pdf?.kind === "ready" && (
							<>
								<a
									href={pdf.value}
									target="_blank"
									rel="noopener"
									className={link}
								>
									Open in new tab
								</a>
								<a
									href={pdf.value}
									download={`lab-report-${reportId.slice(0, 8)}.pdf`}
									className={link}
								>
									Download
								</a>
							</>
						)}
						<Button
							type="button"
							className="h-11 px-4 text-sm"
							autoFocus
							onClick={onClose}
						>
							Close
						</Button>
					</div>
				</div>
			</div>
		</div>
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

	// The server checks that the PDF is the caller's, then gives a link that expires in minutes.
	const download = async (id: string) => {
		const link = await apiRequest(
			ReportPdfLink,
			familyPath(familyId, `/report-pdfs/${encodeURIComponent(id)}`),
		);
		if (link.kind !== "ready") return setFailure(link);
		setFailure(null);
		window.location.assign(link.value.url);
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
