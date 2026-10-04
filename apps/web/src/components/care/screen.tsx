// The frame of the Care › Needs and Care › Contacts tabs: one window for the selected person, or why
// there is none.
import { Me } from "@health/contracts/families";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Window } from "@/components/hud/window";
import { ApiNotice } from "@/components/win95";
import { familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

export function CareScreen({
	title,
	icon,
	children,
}: {
	title: string;
	icon: LucideIcon;
	/** `base` is the family's `/care` API path; `me` is the caller's member identity. */
	children: (base: string, me: string | null) => ReactNode;
}) {
	const { state: familyState, family } = useFamily();
	const meState = useApi(Me, "/api/me");
	const me = meState.kind === "ready" ? meState.value.identity : null;
	return (
		<main className="p-2 sm:p-4">
			<Window
				title={`${title} · ${family?.name ?? "No person"}`}
				icon={icon}
				className="mx-auto w-full max-w-2xl"
				status="Calls are simulated. Only accepting and then confirming help closes a need."
			>
				{familyState.kind !== "ready" ? (
					<ApiNotice state={familyState} what="your family" />
				) : family === null ? (
					<p className="p-3 text-sm">
						No person is paired with this account yet.
					</p>
				) : (
					<div className="grid gap-4 p-2 text-sm">
						{children(familyPath(family.id, "/care"), me)}
					</div>
				)}
			</Window>
		</main>
	);
}
