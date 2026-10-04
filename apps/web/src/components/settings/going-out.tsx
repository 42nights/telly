// Settings › Going out (#302): the clear on/off for automatic trips, how far from home counts as
// out, the saved home, and the optional typed address for Directions home.
import { HOME_RADIUS, type HomeWatch } from "@health/contracts/location";
import { Button } from "@health/ui/components/button";
import { Link } from "@tanstack/react-router";
import { DoorOpen } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { useAutoTrip } from "@/components/trip/auto-trip";
import { ThisIsHome } from "@/components/trip/home-button";
import { HOME_ADDRESS_KEY } from "@/components/trip/logic";
import { ApiNotice, Tip } from "@/components/win95";
import type { ApiResult } from "@/lib/api";

const RADII = [100, 200, 300, 500, 1000, 2000] as const;

export function GoingOutSettings() {
	const { home } = useAutoTrip();
	return (
		<Window
			icon={DoorOpen}
			status={
				home.kind !== "ready"
					? undefined
					: home.value.autoTrip
						? `On · out when farther than ${home.value.radiusMeters} m from home`
						: "Off: Telly does not watch for trips"
			}
			title="Settings · Going out"
		>
			{home.kind === "ready" ? (
				<GoingOutForm
					// A poll with the same values keeps what is being typed.
					key={`${home.value.autoTrip}-${home.value.radiusMeters}`}
					watch={home.value}
				/>
			) : (
				<ApiNotice state={home} what="the going-out settings" />
			)}
			<AddressField />
		</Window>
	);
}

function GoingOutForm({ watch }: { watch: HomeWatch }) {
	const { change } = useAutoTrip();
	const [autoTrip, setAutoTrip] = useState(watch.autoTrip);
	const [radius, setRadius] = useState(watch.radiusMeters);
	const [saved, setSaved] = useState<ApiResult<unknown> | null>(null);
	const save = (home: HomeWatch["home"]) =>
		void change({
			path: "/location/home",
			body: { home, radiusMeters: radius, autoTrip },
		}).then(setSaved);
	return (
		<form
			aria-label="Going out"
			className="grid gap-3 p-2 text-sm"
			onSubmit={(event) => {
				event.preventDefault();
				save(watch.home);
			}}
		>
			<div className="flex items-center gap-1">
				<label className="flex min-h-11 items-center gap-2">
					<input
						checked={autoTrip}
						className="size-5"
						onChange={(event) => setAutoTrip(event.target.checked)}
						type="checkbox"
					/>
					Notice when this person goes out
				</label>
				<Tip text="Telly uses this phone's location. When the person stays farther from home than the distance below for a minute, Telly tells the people they share their location with, and again when they are back. Nothing is sent without the phone's location permission and a share." />
			</div>
			{!watch.sharing && (
				<p className="font-bold">
					This person shares their location with nobody yet. Share it in{" "}
					<Link className="underline" to="/trip">
						Going out
					</Link>
					.
				</p>
			)}
			<label className="grid gap-1">
				Out when farther from home than
				<select
					className="win95-inset win95-field h-11 bg-card px-2 text-base"
					onChange={(event) => setRadius(Number(event.target.value))}
					value={radius}
				>
					{RADII.map((meters) => (
						<option key={meters} value={meters}>
							{meters < 1000 ? `${meters} m` : `${meters / 1000} km`}
							{meters === HOME_RADIUS.default ? " (usual)" : ""}
						</option>
					))}
				</select>
			</label>
			{saved !== null && saved.kind !== "ready" && (
				<p className="font-bold text-destructive" role="alert">
					Not saved:{" "}
					{saved.kind === "signed_out" ? "sign in first." : saved.message}
				</p>
			)}
			<Button
				className="win95-primary h-11 justify-self-end px-6 text-sm"
				type="submit"
			>
				Save
			</Button>
			<fieldset className="grid gap-2 border border-border p-2">
				<legend className="px-1">Home</legend>
				<p className="flex items-center gap-1">
					{watch.home === null ? "No home saved." : "Home saved."}
					<Tip
						text={
							watch.home === null
								? "Press the button while at home."
								: "Home is saved as a position. Only this person can see it."
						}
					/>
				</p>
				<ThisIsHome className="h-11 justify-self-start" />
				{watch.home !== null && (
					<Button
						className="h-11 justify-self-start"
						onClick={() => save(null)}
						type="button"
						variant="outline"
					>
						Forget home
					</Button>
				)}
			</fieldset>
		</form>
	);
}

/** The typed address: kept on this device, used only when no home position is saved. */
function AddressField() {
	const [address, setAddress] = useState(
		() => localStorage.getItem(HOME_ADDRESS_KEY) ?? "",
	);
	return (
		<div className="grid gap-1 p-2 text-sm">
			<span className="flex items-center gap-1">
				<label htmlFor="home-address">Home address (optional)</label>
				<Tip text="Used for Directions home when no position is saved. Kept on this device only." />
			</span>
			<input
				className="win95-inset win95-field h-11 bg-card px-2 text-base"
				id="home-address"
				onChange={(event) => {
					setAddress(event.target.value);
					localStorage.setItem(HOME_ADDRESS_KEY, event.target.value);
				}}
				value={address}
			/>
		</div>
	);
}
