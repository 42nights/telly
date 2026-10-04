import type { Report, ReportReview } from "@health/contracts/reports";
import { useState } from "react";

import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";

import {
	draftOf,
	type FieldDraft,
	fieldErrors,
	fieldsOf,
	formatTime,
} from "./logic";

export const failureText = (failure: ApiFailure) =>
	failure.kind === "signed_out" ? "Sign in again." : failure.message;

/** The status bar text: an action in progress, then a failure, then the report's state. */
const sheetStatus = (sheet: {
	busy: string | null;
	failure: ApiFailure | null;
	review: ReportReview | null;
	dirty: boolean;
	savedAt: number | null;
}): string => {
	if (sheet.busy !== null) return sheet.busy;
	if (sheet.failure !== null) return failureText(sheet.failure);
	if (sheet.review !== null)
		return `Reviewed ${formatTime(sheet.review.reviewedAt)} · read-only · not sent`;
	if (sheet.dirty) return "Draft · changes not saved";
	return sheet.savedAt !== null
		? `Draft · saved ${formatTime(sheet.savedAt)}`
		: "Draft · not sent";
};

export type ReportSheetState = {
	readonly reviewed: boolean;
	readonly draft: FieldDraft;
	readonly setDraft: (draft: FieldDraft) => void;
	readonly errors: Partial<Record<keyof FieldDraft, string>>;
	readonly valid: boolean;
	/** The form differs from the saved fields. */
	readonly dirty: boolean;
	/** The status text of the action in progress, or null. */
	readonly busy: string | null;
	readonly confirmed: boolean;
	readonly setConfirmed: (confirmed: boolean) => void;
	readonly sendFailure: ApiFailure | null;
	readonly save: () => Promise<void>;
	readonly review: () => Promise<void>;
	readonly submit: () => Promise<void>;
	readonly status: string;
};

/** The editable state of one report and its save, review, and submit actions. */
export function useReportSheet(
	report: Report,
	familyId: string,
	onChanged: () => void,
	createFailure: ApiFailure | null,
): ReportSheetState {
	const [draft, setDraft] = useState<FieldDraft>(() => draftOf(report.fields));
	const [busy, setBusy] = useState<string | null>(null);
	const [failure, setFailure] = useState<ApiFailure | null>(createFailure);
	const [confirmed, setConfirmed] = useState(false);
	const [sendFailure, setSendFailure] = useState<ApiFailure | null>(null);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	const errors = fieldErrors(draft);
	const saved = draftOf(report.fields);
	const dirty = (Object.keys(draft) as (keyof FieldDraft)[]).some(
		(name) => draft[name].trim() !== saved[name],
	);
	const base = familyPath(
		familyId,
		`/reports/${encodeURIComponent(report.id)}`,
	);

	const post = async (path: string, label: string, body?: unknown) => {
		setBusy(label);
		const result = await apiRequest(null, `${base}${path}`, {
			method: "POST",
			...(body === undefined ? {} : { body }),
		});
		setBusy(null);
		if (result.kind !== "ready") setFailure(result);
		return result.kind === "ready";
	};

	const save = async () => {
		if (!(await post("/fields", "Saving…", fieldsOf(draft)))) return;
		setFailure(null);
		setSavedAt(Date.now());
		onChanged();
	};

	const review = async () => {
		if (!(await post("/review", "Marking as reviewed…"))) return;
		setFailure(null);
		onChanged();
	};

	const submit = async () => {
		setBusy("Sending…");
		const result = await apiRequest(null, `${base}/submit`, {
			method: "POST",
		});
		setBusy(null);
		// The server has no delivery path; any other reply is still not a delivery receipt.
		setSendFailure(
			result.kind === "ready"
				? {
						kind: "error",
						message: "The server replied, but gave no delivery receipt.",
					}
				: result,
		);
	};

	return {
		reviewed: report.review !== null,
		draft,
		setDraft,
		errors,
		valid: Object.keys(errors).length === 0,
		dirty,
		busy,
		confirmed,
		setConfirmed,
		sendFailure,
		save,
		review,
		submit,
		status: sheetStatus({
			busy,
			failure: sendFailure ?? failure,
			review: report.review,
			dirty,
			savedAt,
		}),
	};
}
