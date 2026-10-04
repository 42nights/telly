// The Care › Care plan and Care › Sharing tabs (#26, docs/board.html#wf-family). Each part needs its
// own grant; a part without one says so instead of showing nothing.
import type { ReactNode } from "react";

import { ApiNotice } from "@/components/win95";
import type { ApiState } from "@/lib/api";

import { type CareData, useCare } from "./data";

/** Loads the person's care plan data for `children`. */
export function CareParts({
	familyId,
	children,
}: {
	familyId: string;
	children: (care: CareData) => ReactNode;
}) {
	return children(useCare(familyId));
}

/** A part's data, or why it is missing. A 403 here is a missing care grant, not a missing family. */
export function Part<T>({
	state,
	what,
	children,
}: {
	state: ApiState<T>;
	what: string;
	children: (value: T) => ReactNode;
}) {
	if (state.kind === "ready") return children(state.value);
	if (state.kind === "forbidden")
		return (
			<p role="alert" className="win95-raised p-3 text-sm">
				No access to {what}: {state.message}. Ask the person who manages
				sharing.
			</p>
		);
	return <ApiNotice state={state} what={what} />;
}
