// "This is home" (#302): one tap saves the current position as home and turns on automatic trips.
// The first time, with no share yet, it also shares the location with every family member: the
// family is why the wearer uses Telly, and each one can be turned off in "Who sees where I am".
import { FamilyMembers, Me } from "@health/contracts/families";
import {
	APPROXIMATE_METERS,
	FamilyLocations,
	HOME_RADIUS,
} from "@health/contracts/location";
import { Button } from "@health/ui/components/button";
import { useState } from "react";

import { apiRequest, familyPath } from "@/lib/api";

import { useAutoTrip } from "./auto-trip";

type Step =
	| { readonly kind: "idle" | "locating" }
	| { readonly kind: "failed"; readonly message: string };

const position = () =>
	new Promise<GeolocationPosition>((resolve, reject) => {
		if (!("geolocation" in navigator))
			reject(new Error("This browser cannot tell where it is."));
		else
			navigator.geolocation.getCurrentPosition(resolve, reject, {
				enableHighAccuracy: true,
				maximumAge: 0,
				timeout: 30_000,
			});
	});

const shareWithFamily = async (familyId: string) => {
	const [members, me] = await Promise.all([
		apiRequest(FamilyMembers, familyPath(familyId, "/members")),
		apiRequest(Me, "/api/me"),
	]);
	if (members.kind !== "ready" || me.kind !== "ready") return;
	for (const { identity } of members.value.members)
		if (identity !== me.value.identity)
			await apiRequest(
				FamilyLocations,
				familyPath(familyId, `/location/shares/${identity}`),
				{ method: "PUT" },
			);
};

export function ThisIsHome({ className }: { className: string }) {
	const { familyId, home, change, refresh } = useAutoTrip();
	const first =
		home.kind === "ready" && home.value.home === null && !home.value.sharing;
	const [step, setStep] = useState<Step>({ kind: "idle" });
	const save = async () => {
		setStep({ kind: "locating" });
		const fix = await position().catch(
			(error: unknown) =>
				new Error(
					error instanceof Error
						? error.message
						: typeof error === "object" &&
								error !== null &&
								"code" in error &&
								error.code === 1
							? "Location is off for this app. Allow it, then try again."
							: "Telly could not find where you are. Try again.",
				),
		);
		if (fix instanceof Error) {
			setStep({ kind: "failed", message: fix.message });
			return;
		}
		const accuracy = Math.round(fix.coords.accuracy);
		if (accuracy > APPROXIMATE_METERS) {
			setStep({
				kind: "failed",
				message: `Telly found your position only within ${accuracy} m. Go near a window and try again.`,
			});
			return;
		}
		const result = await change({
			path: "/location/home",
			body: {
				home: {
					latitude: fix.coords.latitude,
					longitude: fix.coords.longitude,
				},
				radiusMeters:
					home.kind === "ready" ? home.value.radiusMeters : HOME_RADIUS.default,
				autoTrip: true,
			},
		});
		if (result.kind === "ready" && first && familyId !== null) {
			await shareWithFamily(familyId);
			refresh();
		}
		setStep(
			result.kind === "ready"
				? { kind: "idle" }
				: {
						kind: "failed",
						message:
							result.kind === "signed_out"
								? "Not saved: sign in again."
								: `Not saved: ${result.message}`,
					},
		);
	};
	return (
		<>
			<Button
				type="button"
				className={className}
				disabled={step.kind === "locating"}
				onClick={() => void save()}
			>
				{step.kind === "locating" ? "Finding where you are…" : "This is home"}
			</Button>
			{step.kind === "failed" && (
				<p
					className="col-span-full font-bold text-[16px] text-destructive"
					role="alert"
				>
					{step.message}
				</p>
			)}
		</>
	);
}
