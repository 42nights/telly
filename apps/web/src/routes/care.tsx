import { createFileRoute } from "@tanstack/react-router";

import { CareWindow } from "@/components/care/needs-window";
import { CareScreen } from "@/components/care/screen";

// Care › Needs (#30): the family's open needs and the ask form.
export const Route = createFileRoute("/care")({
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
