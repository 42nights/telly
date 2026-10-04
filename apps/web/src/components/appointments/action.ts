// The write helper and the control styles shared by the appointment screen's panels.
import { useState } from "react";

import { type ApiFailure, apiRequest } from "@/lib/api";

/** One write: shows `label` while it runs and resolves to whether it succeeded. */
export type RunAction = (
	label: string,
	path: string,
	method: "POST" | "PUT",
	body?: unknown,
) => Promise<boolean>;

/** Runs one write and keeps its failure visible; `onDone` refreshes the screen after a success. */
export function useAction(onDone: () => void) {
	const [busy, setBusy] = useState<string | null>(null);
	const [failure, setFailure] = useState<ApiFailure | null>(null);
	const run: RunAction = async (label, path, method, body) => {
		setBusy(label);
		const result = await apiRequest(null, path, {
			method,
			...(body === undefined ? {} : { body }),
		});
		setBusy(null);
		if (result.kind !== "ready") {
			setFailure(result);
			return false;
		}
		setFailure(null);
		onDone();
		return true;
	};
	return { busy, failure, run };
}

export const fieldClass =
	"win95-inset win95-field min-w-0 bg-card px-2 py-1 text-sm";
export const buttonClass = "h-11 px-3 text-sm";
