// "Going out" (issues #40 and #302): a status view, not a form, that fits one phone screen. Telly
// learns home from the phone's location and notices a trip by itself (`AutoTripProvider`); this
// screen shows one status line, "Help me get home", and who sees where the wearer is.
import { FamilyMembers, Me } from "@health/contracts/families";
import { FamilyLocations, HomeWatch } from "@health/contracts/location";
import { createFileRoute } from "@tanstack/react-router";
import { Footprints } from "lucide-react";

import { Window } from "@/components/hud/window";
import { useAutoTrip } from "@/components/trip/auto-trip";
import { HelpHome } from "@/components/trip/help-home";
import { WhoSeesMe } from "@/components/trip/location";
import { tripStatus } from "@/components/trip/logic";
import { useNow } from "@/components/wearer/use-now";
import { ApiNotice } from "@/components/win95";
import { familyPath, useApi } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/trip")({
	loader: loadFamilyReads((familyId) => [
		[Me, "/api/me"],
		[HomeWatch, familyPath(familyId, "/location/home")],
		[FamilyLocations, familyPath(familyId, "/location")],
		[FamilyMembers, familyPath(familyId, "/members")],
	]),
	component: TripScreen,
});

function TripScreen() {
	const { familyId, home, reporting } = useAutoTrip();
	const now = useNow();
	// A share change marks this read stale (`apiRequest`).
	const locations = useApi(
		FamilyLocations,
		familyId === null ? null : familyPath(familyId, "/location"),
		{ pollMs: 30_000 },
	);
	const me = useApi(Me, "/api/me");
	return (
		<main className="win95-desktop min-h-0 overflow-y-auto p-2 sm:p-4">
			<Window
				title="Going out"
				icon={Footprints}
				className="mx-auto w-full max-w-xl"
			>
				<div className="grid gap-3 p-2 text-[18px]">
					{home.kind !== "ready" ? (
						<ApiNotice state={home} what="your trip status" />
					) : (
						<p className="font-bold text-2xl" role="status">
							{tripStatus(home.value, now)}
						</p>
					)}
					{reporting.kind === "failed" && (
						<p className="font-bold text-[16px] text-destructive" role="alert">
							{reporting.message}
						</p>
					)}

					<HelpHome
						familyId={familyId}
						watch={home.kind === "ready" ? home.value : null}
					/>

					{locations.kind !== "ready" ? (
						<ApiNotice state={locations} what="who sees where you are" />
					) : me.kind !== "ready" || familyId === null ? (
						<ApiNotice
							state={me.kind === "ready" ? { kind: "loading" } : me}
							what="who sees where you are"
						/>
					) : (
						<WhoSeesMe
							familyId={familyId}
							me={me.value.identity}
							locations={locations.value}
						/>
					)}
				</div>
			</Window>
		</main>
	);
}
