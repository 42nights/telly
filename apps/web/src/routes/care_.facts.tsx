// Care › Profile (#26): the care profile, every fact the wearer's prompts use.
import { createFileRoute } from "@tanstack/react-router";

import { CareScreen } from "@/components/care/screen";
import { careReads } from "@/components/care-profile/data";
import { ProfileWindow } from "@/components/care-profile/profile-window";
import { CareParts, Part } from "@/components/care-profile/screen";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/care_/facts")({
	loader: loadFamilyReads(careReads),
	component: () => (
		<CareScreen>
			{(familyId) => (
				<CareParts key={familyId} familyId={familyId}>
					{(care) => {
						const canEdit =
							care.access.kind === "ready" &&
							care.access.value.mine.includes("care_plan_edit");
						return (
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
						);
					}}
				</CareParts>
			)}
		</CareScreen>
	),
});
