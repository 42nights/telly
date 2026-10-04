import { ContactLadderReply } from "@health/contracts/care";
import { Me } from "@health/contracts/families";
import { createFileRoute } from "@tanstack/react-router";

import { CareWindow } from "@/components/care/needs-window";
import { CareScreen } from "@/components/care/screen";
import { familyPath } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

// Care › Contacts (#30): the family contact ladder, in the order Telly asks people for help.
export const Route = createFileRoute("/care_/contacts")({
	loader: loadFamilyReads((familyId) => [
		[Me, "/api/me"],
		[ContactLadderReply, familyPath(familyId, "/care/ladder")],
	]),
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
