import { CareNeeds } from "@health/contracts/care";
import { Me } from "@health/contracts/families";
import { createFileRoute } from "@tanstack/react-router";

import { CareWindow } from "@/components/care/needs-window";
import { CareScreen } from "@/components/care/screen";
import { familyPath } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

// Care › Needs (#30): the family's open needs and the ask form.
export const Route = createFileRoute("/care")({
	loader: loadFamilyReads((familyId) => [
		[Me, "/api/me"],
		[CareNeeds, familyPath(familyId, "/care/needs")],
	]),
	component: () => (
		<CareScreen>
			{(familyId) => (
				<div className="mx-auto w-full max-w-2xl">
					<CareWindow key={familyId} familyId={familyId} part="needs" />
				</div>
			)}
		</CareScreen>
	),
});
