// Settings › Saved things (#301): one member's saved things, each with Remove, and Forget
// everything for the member. Remembering is on for every member, so this page only removes things,
// or opens Add a thing in the finder. Only the member, family admins, and caregivers see it.
import type { MedicineMemory } from "@health/contracts/medicine-memory";
import { Button, buttonVariants } from "@health/ui/components/button";
import { Link } from "@tanstack/react-router";
import { History, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { Thumb } from "@/components/wearer/last-seen";
import { ago, objectName } from "@/components/wearer/logic";
import { useNow } from "@/components/wearer/use-now";
import { ApiNotice, Tip } from "@/components/win95";
import type { ApiResult } from "@/lib/api";
import { useFamily } from "@/lib/family";
import {
	type MedicineMemoryChange,
	useChosenMedicineMemory,
	WhoseMedicinesPicker,
} from "@/lib/medicine-memory";

export function SavedThingsSettings() {
	const { family } = useFamily();
	const { memory, change, choose } = useChosenMedicineMemory(
		family?.id ?? null,
	);
	return (
		<Window
			icon={History}
			status={
				memory.kind === "ready"
					? `${memory.value.sightings.length} saved`
					: undefined
			}
			title="Settings · Saved things"
		>
			<WhoseMedicinesPicker
				choose={choose}
				className="p-2 [&_select]:min-w-0 [&_select]:flex-1"
				memory={memory}
			/>
			{memory.kind === "ready" ? (
				<ThingList change={change} key={memory.at} memory={memory.value} />
			) : (
				<ApiNotice state={memory} what="saved things" />
			)}
		</Window>
	);
}

/** A Win95 confirm box: the question, what it deletes, and the two answers. */
function Confirm({
	question,
	detail,
	yes,
	onYes,
	onNo,
	busy,
}: {
	question: string;
	detail: string;
	yes: string;
	onYes: () => void;
	onNo: () => void;
	busy: boolean;
}) {
	return (
		<div
			aria-label={question}
			className="win95-raised grid gap-2 bg-card p-3"
			role="alertdialog"
		>
			<p className="font-bold">{question}</p>
			<p>{detail}</p>
			<div className="flex flex-wrap justify-end gap-2">
				<Button
					className="win95-primary h-11 px-5 text-sm"
					disabled={busy}
					onClick={onYes}
				>
					{yes}
				</Button>
				<Button className="h-11 px-5 text-sm" onClick={onNo} variant="outline">
					Cancel
				</Button>
			</div>
		</div>
	);
}

function ThingList({
	memory,
	change,
}: {
	memory: MedicineMemory;
	change: MedicineMemoryChange;
}) {
	const now = useNow();
	// The id of the thing whose Remove is being confirmed, or "all" for Forget everything.
	const [asking, setAsking] = useState<string | null>(null);
	const [sent, setSent] = useState<ApiResult<unknown> | "sending" | null>(null);
	const run = async (
		method: "PUT" | "DELETE",
		path: string,
		body?: unknown,
	) => {
		setSent("sending");
		const result = await change(method, path, body);
		setSent(result);
		if (result.kind === "ready") setAsking(null);
	};
	const busy = sent === "sending";
	const { sightings } = memory;
	return (
		<div className="grid gap-3 p-2 text-sm">
			<div className="flex items-center gap-2">
				<Link
					className={buttonVariants({
						variant: "outline",
						className: "h-11 px-4 text-sm",
					})}
					data-slot="button"
					search={{ mode: "add", member: memory.personId }}
					to="/find"
				>
					<Plus aria-hidden />
					Add a thing
				</Link>
				<Tip text="Telly remembers where each saved thing was last seen, with a small picture. Only this member, family admins, and caregivers can see them." />
			</div>
			{sightings.length === 0 ? (
				<p className="font-bold">No saved things yet.</p>
			) : (
				<ul aria-label="Saved things" className="grid gap-2">
					{sightings.map((s) => {
						const name = objectName(s.category, s.container);
						return (
							<li className="grid gap-2" key={s.id}>
								<div className="win95-inset flex items-center gap-3 bg-card p-2">
									<Thumb sighting={s} />
									<span className="grid min-w-0 flex-1">
										<b className="break-words">{name}</b>
										<span className="break-words text-muted-foreground">
											{s.place} · {ago(now - Date.parse(s.seenAt))}
										</span>
									</span>
									<Button
										aria-label={`Remove ${name}`}
										className="h-11 px-3 text-sm"
										onClick={() => setAsking(s.id)}
										variant="outline"
									>
										<Trash2 aria-hidden />
										Remove
									</Button>
								</div>
								{asking === s.id && (
									<Confirm
										busy={busy}
										detail="Its place, picture, and AR pin are deleted too."
										onNo={() => setAsking(null)}
										onYes={() => void run("DELETE", `/sightings/${s.id}`)}
										question={`Remove ${name}?`}
										yes="Remove"
									/>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{sightings.length > 0 && (
				<Button
					className="h-11 justify-self-end px-4 text-sm"
					onClick={() => setAsking("all")}
					variant="outline"
				>
					Forget everything
				</Button>
			)}
			{asking === "all" && (
				<Confirm
					busy={busy}
					detail="Every saved thing of this member, their places, pictures, and AR room maps are deleted. This cannot be undone."
					onNo={() => setAsking(null)}
					onYes={() => void run("PUT", "", { enabled: false, places: [] })}
					question="Forget everything?"
					yes="Forget everything"
				/>
			)}
			{sent !== null && sent !== "sending" && sent.kind !== "ready" && (
				<p className="font-bold text-destructive" role="alert">
					Not changed:{" "}
					{sent.kind === "signed_out" ? "sign in first." : sent.message}
				</p>
			)}
		</div>
	);
}
