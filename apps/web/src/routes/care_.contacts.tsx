import { createFileRoute } from "@tanstack/react-router";

import { CareWindow } from "@/components/care/needs-window";
import { CareScreen } from "@/components/care/screen";

// Care › Contacts (#30): the family contact ladder, in the order Telly asks people for help.
export const Route = createFileRoute("/care_/contacts")({
	component: () => (
		<CareScreen>
			{(familyId) => (
				<div className="mx-auto w-full max-w-2xl">
					<CareWindow key={familyId} familyId={familyId} part="ladder" />
				</div>
			)}
		</CareScreen>
	),
});
