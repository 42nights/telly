import type { MedicineMemory } from "@health/contracts/medicine-memory";
import { Button } from "@health/ui/components/button";
import { History } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { ApiNotice } from "@/components/win95";
import type { ApiResult } from "@/lib/api";
import { useFamily } from "@/lib/family";
import {
	type MedicineMemoryChange,
	useChosenMedicineMemory,
	WhoseMedicinesPicker,
} from "@/lib/medicine-memory";

/** One member's permission to remember where their medicine was last seen, and their places. */
export function MedicineMemorySettings() {
	const { family } = useFamily();
	const { memory, change, choose } = useChosenMedicineMemory(
		family?.id ?? null,
	);
	return (
		<Window
			icon={History}
			status={
				memory.kind !== "ready"
					? undefined
					: memory.value.permission === null
						? "Off: no places are saved"
						: `On · saved ${new Date(memory.value.permission.setAt).toLocaleString()}`
			}
			title="Settings · Medicine places"
		>
			<WhoseMedicinesPicker
				choose={choose}
				className="p-2 [&_select]:min-w-0 [&_select]:flex-1"
				memory={memory}
			/>
			{memory.kind === "ready" ? (
				<MemoryForm change={change} key={memory.at} memory={memory.value} />
			) : (
				<ApiNotice state={memory} what="medicine places" />
			)}
		</Window>
	);
}

function MemoryForm({
	memory,
	change,
}: {
	memory: MedicineMemory;
	change: MedicineMemoryChange;
}) {
	const on = memory.permission !== null;
	const [enabled, setEnabled] = useState(on);
	const [places, setPlaces] = useState(
		memory.permission?.places.join("\n") ?? "",
	);
	const [saved, setSaved] = useState<ApiResult<unknown> | null>(null);
	const list = places
		.split("\n")
		.map((place) => place.trim())
		.filter(Boolean);
	return (
		<form
			aria-label="Medicine places"
			className="grid gap-3 p-2 text-sm"
			onSubmit={(event) => {
				event.preventDefault();
				void change("PUT", "", {
					enabled,
					places: enabled ? list : [],
				}).then(setSaved);
			}}
		>
			<label className="flex min-h-11 items-center gap-2">
				<input
					checked={enabled}
					className="size-5"
					onChange={(event) => setEnabled(event.target.checked)}
					type="checkbox"
				/>
				Remember where medicine was last seen
			</label>
			<p>
				After a camera check finds a medicine container, you can save the room
				or landmark where it is. Only this member, family admins, and caregivers
				can see it.
			</p>
			{enabled ? (
				<label className="grid gap-1">
					Places to look when it moved (one per line, at most 12)
					<textarea
						className="win95-inset win95-field min-h-24 w-full bg-card p-2 text-base"
						onChange={(event) => setPlaces(event.target.value)}
						value={places}
					/>
				</label>
			) : (
				on && (
					<p className="font-bold">
						Turning this off deletes every saved place of this member.
					</p>
				)
			)}
			{saved !== null && saved.kind !== "ready" && (
				<p className="font-bold text-destructive" role="alert">
					Not saved:{" "}
					{saved.kind === "signed_out" ? "sign in first." : saved.message}
				</p>
			)}
			<Button
				className="win95-primary h-11 justify-self-end px-6 text-sm"
				disabled={list.length > 12 || list.some((p) => p.length > 120)}
				type="submit"
			>
				Save
			</Button>
		</form>
	);
}
