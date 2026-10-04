// Care › Care plan (#26): the care profile, the care instructions, and what the wearer hears.
import { createFileRoute } from "@tanstack/react-router";
import { MessageSquareText } from "lucide-react";

import { CareScreen } from "@/components/care/screen";
import { careReads } from "@/components/care-profile/data";
import { InstructionsWindow } from "@/components/care-profile/instructions-window";
import { ProfileWindow } from "@/components/care-profile/profile-window";
import { CareParts, Part } from "@/components/care-profile/screen";
import { Window } from "@/components/hud/window";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/care_/plan")({
	loader: loadFamilyReads(careReads),
	component: () => (
		<CareScreen>
			{(familyId) => (
				<CareParts key={familyId} familyId={familyId}>
					{(care) => {
						const mine =
							care.access.kind === "ready" ? care.access.value.mine : [];
						const canEdit = mine.includes("care_plan_edit");
						return (
							<div className="grid items-start gap-3 lg:grid-cols-2">
								<div className="grid gap-3">
									<Part state={care.prompt} what="the wearer's prompt">
										{({ lines }) => (
											<Window
												title="What the wearer hears"
												icon={MessageSquareText}
											>
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
						);
					}}
				</CareParts>
			)}
		</CareScreen>
	),
});
