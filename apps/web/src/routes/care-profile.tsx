// The care plan (#26, docs/board.html#wf-family): profile, instructions, sharing, and what the wearer
// hears. Each part needs its own grant; a part without one says so instead of showing nothing.
import { createFileRoute } from "@tanstack/react-router";
import { MessageSquareText } from "lucide-react";
import type { ReactNode } from "react";

import { type CareData, useCare } from "@/components/care-profile/data";
import { InstructionsWindow } from "@/components/care-profile/instructions-window";
import { ProfileWindow } from "@/components/care-profile/profile-window";
import { SharingWindow } from "@/components/care-profile/sharing-window";
import { Window } from "@/components/hud/window";
import { ApiNotice } from "@/components/win95";
import type { ApiState } from "@/lib/api";
import { PersonPicker, useFamily } from "@/lib/family";

export const Route = createFileRoute("/care-profile")({
	component: CarePlanScreen,
});

function CarePlanScreen() {
	const { state, family } = useFamily();
	return (
		<main className="win95-desktop min-h-0 overflow-y-auto p-2 sm:p-4">
			<div className="mx-auto grid w-full max-w-5xl gap-3">
				<PersonPicker />
				{state.kind !== "ready" ? (
					<ApiNotice state={state} what="your family" />
				) : family === null ? (
					<p className="win95-raised p-3 text-sm">
						No person is paired with this account yet.
					</p>
				) : (
					<CarePlan key={family.id} familyId={family.id} />
				)}
			</div>
		</main>
	);
}

/** A part's data, or why it is missing. A 403 here is a missing care grant, not a missing family. */
function Part<T>({
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

function CarePlan({ familyId }: { familyId: string }) {
	const care: CareData = useCare(familyId);
	const mine = care.access.kind === "ready" ? care.access.value.mine : [];
	const canEdit = mine.includes("care_plan_edit");
	return (
		<div className="grid items-start gap-3 lg:grid-cols-2">
			<div className="grid gap-3">
				<Part state={care.access} what="sharing">
					{(access) => <SharingWindow access={access} care={care} />}
				</Part>
				<Part state={care.prompt} what="the wearer's prompt">
					{({ lines }) => (
						<Window title="What the wearer hears" icon={MessageSquareText}>
							<ul className="grid list-disc gap-1 p-2 pl-6 text-sm">
								{lines.map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
						</Window>
					)}
				</Part>
				<Part state={care.instructions} what="care instructions">
					{({ instructions }) => (
						<InstructionsWindow
							instructions={instructions}
							canEdit={canEdit}
							care={care}
						/>
					)}
				</Part>
			</div>
			<div className="grid gap-3">
				<Part state={care.profile} what="the care profile">
					{(record) => (
						<ProfileWindow
							key={`${record.editedAt}:${canEdit}`}
							record={record}
							canEdit={canEdit}
							care={care}
						/>
					)}
				</Part>
			</div>
		</div>
	);
}
