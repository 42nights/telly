import {
	type Report,
	ReportFields,
	type ReportReview,
} from "@health/contracts/reports";
import { Schema } from "effect";
import { useState } from "react";

import { type ApiFailure, apiRequest, familyPath } from "@/lib/api";

import {
	draftChanged,
	draftOf,
	type FieldDraft,
	type FieldName,
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
	readonly errors: Partial<Record<FieldName, string>>;
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
	// A "New report" that fails while this sheet is open keeps the sheet, so show the failure here.
	const [seenCreateFailure, setSeenCreateFailure] = useState(createFailure);
	if (createFailure !== seenCreateFailure) {
		setSeenCreateFailure(createFailure);
		setFailure(createFailure);
	}
	const [confirmed, setConfirmed] = useState(false);
	const [sendFailure, setSendFailure] = useState<ApiFailure | null>(null);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	const errors = fieldErrors(draft);
	const dirty = draftChanged(draft, draftOf(report.fields));
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
		// The field messages explain the usual failure; the shared schema decides.
		valid: Schema.is(ReportFields)(fieldsOf(draft)),
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
