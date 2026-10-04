// The frame of every Care tab: the person picker, then the tab's windows for the selected person,
// or why there is no person.
import type { ReactNode } from "react";

import { ApiNotice } from "@/components/win95";
import { PersonPicker, useFamily } from "@/lib/family";

export function CareScreen({
	children,
}: {
	children: (familyId: string) => ReactNode;
}) {
	const { state, family } = useFamily();
	return (
		<main>
			<div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-2">
				<PersonPicker />
				{state.kind !== "ready" ? (
					<ApiNotice state={state} what="your family" />
				) : family === null ? (
					<p className="win95-raised p-3 text-sm">
						No person is paired with this account yet.
					</p>
				) : (
					children(family.id)
				)}
			</div>
		</main>
	);
}
