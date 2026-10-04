// Demo data (#334): the database replays a real WHOOP recording as live, for the demo video. It is
// on while the family's records hold a demo copy (`DEMO_SOURCE`); turning it off deletes them all.
import { DEMO_SOURCE, FamilyRecords } from "@health/contracts";
import { Button } from "@health/ui/components/button";
import { PlayCircle } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { apiRequest, familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

/** The selected family and whether it replays demo data, or null while either is unknown. */
export function useDemoData() {
	const { family } = useFamily();
	const records = useApi(
		FamilyRecords,
		family === null ? null : familyPath(family.id),
	);
	if (family === null || records.kind !== "ready") return null;
	return {
		familyId: family.id,
		on: records.value.samples.some(
			(s) => s.familyId === family.id && s.source === DEMO_SOURCE,
		),
	};
}

/** The switch and alert writes, with the one in flight and the last failure. */
function useDemoWrites(familyId: string) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const write = async (path: string, body?: { on: boolean }) => {
		setBusy(true);
		setError(null);
		const result = await apiRequest(null, familyPath(familyId, path), {
			method: body === undefined ? "POST" : "PUT",
			...(body === undefined ? {} : { body }),
		});
		setBusy(false);
		if (result.kind !== "ready")
			setError(
				result.kind === "signed_out" ? "sign in first." : result.message,
			);
	};
	return {
		busy,
		error,
		setOn: (on: boolean) => write("/demo-data", { on }),
		showAlert: () => write("/demo-data/alert"),
	};
}

function WriteError({ error }: { error: string | null }) {
	return error === null ? null : (
		<p className="font-bold text-destructive" role="alert">
			Not done: {error}
		</p>
	);
}

/** Settings › Demo data. */
export function DemoDataSettings() {
	const demo = useDemoData();
	if (demo === null) return null;
	return <DemoDataWindow familyId={demo.familyId} on={demo.on} />;
}

function DemoDataWindow({ familyId, on }: { familyId: string; on: boolean }) {
	const { busy, error, setOn, showAlert } = useDemoWrites(familyId);
	return (
		<Window title="Settings · Demo data" icon={PlayCircle}>
			<div className="grid gap-3 p-2 text-sm">
				<label className="flex min-h-11 items-center gap-2">
					<input
						checked={on}
						className="size-5"
						disabled={busy}
						onChange={(event) => void setOn(event.target.checked)}
						type="checkbox"
					/>
					Demo data
				</label>
				<p>
					Replays a real WHOOP recording as if the strap were live, so every
					screen shows current readings. Turning it off deletes the replayed
					readings; real readings stay.
				</p>
				{on && (
					<Button
						className="h-11 justify-self-start px-6 text-sm"
						disabled={busy}
						onClick={() => void showAlert()}
					>
						Show an alert
					</Button>
				)}
				<WriteError error={error} />
			</div>
		</Window>
	);
}

/** The family view's empty state: one tap to replay demo data. */
export function UseDemoData({ familyId }: { familyId: string }) {
	const { busy, error, setOn } = useDemoWrites(familyId);
	return (
		<div className="grid gap-1">
			<Button
				className="win95-primary h-11 justify-self-start px-6 text-sm"
				disabled={busy}
				onClick={() => void setOn(true)}
			>
				Use demo data
			</Button>
			<WriteError error={error} />
		</div>
	);
}
