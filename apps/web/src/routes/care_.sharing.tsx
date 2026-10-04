// Care › Sharing (#26): who in the family may see and change each part of the care plan.
import { createFileRoute } from "@tanstack/react-router";

import { CareScreen } from "@/components/care/screen";
import { CareParts, Part } from "@/components/care-profile/screen";
import { SharingWindow } from "@/components/care-profile/sharing-window";

export const Route = createFileRoute("/care_/sharing")({
	component: () => (
		<CareScreen>
			{(familyId) => (
				<CareParts key={familyId} familyId={familyId}>
					{(care) => (
						<div className="mx-auto w-full max-w-2xl">
							<Part state={care.access} what="sharing">
								{(access) => <SharingWindow access={access} care={care} />}
							</Part>
						</div>
					)}
				</CareParts>
			)}
		</CareScreen>
	),
});
