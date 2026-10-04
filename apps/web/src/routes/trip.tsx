// "Going out" (issues #40 and #302): a status view, not a form, that fits one phone screen. Telly
// notices a trip from the phone's location (`AutoTripProvider`); this screen shows it, offers "Help
// me get home" and a call, keeps "I'm going out" as an optional button, and lists who sees where
// the wearer is.
import { Me } from "@health/contracts/families";
import { FamilyLocations, type HomeWatch } from "@health/contracts/location";
import { Button } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { Footprints } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { useAutoTrip } from "@/components/trip/auto-trip";
import { HelpHome } from "@/components/trip/help-home";
import { ThisIsHome } from "@/components/trip/home-button";
import { WhoSeesMe } from "@/components/trip/location";
import { tripStatus } from "@/components/trip/logic";
import type { Reporting } from "@/components/trip/use-trip";
import { useNow } from "@/components/wearer/use-now";
import { ApiNotice } from "@/components/win95";
import { familyPath, useApi } from "@/lib/api";

export const Route = createFileRoute("/trip")({ component: TripScreen });
const big = "h-14 text-[18px]";

function TripScreen() {
	const { familyId, home, reporting, refresh } = useAutoTrip();
	const [shareChange, setShareChange] = useState(0);
	// Shares also change from "This is home" (the first one shares with the family).
	const sharing = home.kind === "ready" && home.value.sharing;
	const locations = useApi(
		FamilyLocations,
		familyId === null ? null : familyPath(familyId, "/location"),
		{ pollMs: 30_000, refreshKey: `${shareChange}-${sharing}` },
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
						<TripStatus watch={home.value} reporting={reporting} />
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
							onChange={() => {
								setShareChange((n) => n + 1);
								refresh();
							}}
						/>
					)}
				</div>
			</Window>
		</main>
	);
}

function TripStatus({
	watch,
	reporting,
}: {
	watch: HomeWatch;
	reporting: Reporting;
}) {
	const now = useNow();
	const { change } = useAutoTrip();
	const [error, setError] = useState<string | null>(null);
	const away = watch.awaySince !== null;
	const setAway = async (next: boolean) => {
		setError(null);
		const result = await change({
			path: "/location/away",
			body: { away: next },
		});
		if (result.kind !== "ready")
			setError(
				result.kind === "signed_out"
					? "Not saved: sign in again."
					: `Not saved: ${result.message}`,
			);
	};
	// A failed button press first; otherwise a refused position report.
	const problem =
		error ?? (reporting.kind === "failed" ? reporting.message : null);

	return (
		<section aria-labelledby="trip" className="grid gap-2">
			<h3 id="trip" className="font-bold text-2xl">
				{away ? "You are out" : "Going out"}
			</h3>
			<p role="status">{tripStatus(watch, now)}</p>
			<div className="grid grid-cols-2 gap-2">
				{watch.home === null && (
					<ThisIsHome className={`${big} win95-primary`} />
				)}
				<Button
					className={`${big} ${watch.home === null ? "" : "col-span-2"}`}
					onClick={() => void setAway(!away)}
					variant="outline"
				>
					{away ? "I'm back home" : "I'm going out"}
				</Button>
			</div>
			{problem !== null && (
				<p className="font-bold text-[16px] text-destructive" role="alert">
					{problem}
				</p>
			)}
		</section>
	);
}
