import { Me } from "@health/contracts/families";
import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";

import { FamilyPeople } from "@/components/family/invite";
import { Window } from "@/components/hud/window";
import { DeleteFamilySettings } from "@/components/settings/delete-family";
import { useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

export const Route = createFileRoute("/settings_/family")({
	component: () => (
		<main className="mx-auto grid w-full max-w-xl gap-3 p-2 md:p-6">
			<FamilySettings />
			<DeleteFamilySettings />
		</main>
	),
});

function FamilySettings() {
	const { family } = useFamily();
	const me = useApi(Me, "/api/me");
	return (
		<Window icon={Users} title="Settings · Family">
			<div className="p-2 text-sm">
				{family === null ? (
					<p>No person is paired yet.</p>
				) : (
					<FamilyPeople
						familyId={family.id}
						familyName={family.name}
						me={me.kind === "ready" ? me.value.identity : null}
					/>
				)}
			</div>
		</Window>
	);
}
