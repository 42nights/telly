import {
	type CookingProfile,
	CookingProfileRecord,
	type CookingTask,
	type TaskSupport,
} from "@health/contracts/cooking";
import { Button } from "@health/ui/components/button";
import { useState } from "react";

import { ApiNotice } from "@/components/win95";
import { apiRequest, familyPath, useApi } from "@/lib/api";

const tasks: Record<CookingTask, string> = {
	stove: "Stove",
	oven: "Oven",
	microwave: "Microwave",
	toaster: "Toaster",
	knife: "Sharp knife",
};

const supports: Record<TaskSupport, string> = {
	alone: "Alone",
	with_helper: "With a helper",
	not_allowed: "Not allowed",
};

const unknown: CookingProfile = {
	tasks: {
		stove: "with_helper",
		oven: "with_helper",
		microwave: "with_helper",
		toaster: "with_helper",
		knife: "with_helper",
	},
	dislikes: [],
};

function Editor({
	familyId,
	saved,
}: {
	familyId: string;
	saved: CookingProfileRecord;
}) {
	const [profile, setProfile] = useState(saved.profile ?? unknown);
	const [dislikes, setDislikes] = useState(profile.dislikes.join(", "));
	const [status, setStatus] = useState<string | null>(null);
	const save = async () => {
		setStatus("Saving…");
		const result = await apiRequest(
			null,
			familyPath(familyId, "/cooking/profile"),
			{
				method: "PUT",
				body: {
					...profile,
					dislikes: dislikes
						.split(",")
						.map((s) => s.trim().slice(0, 80))
						.filter((s) => s !== "")
						.slice(0, 30),
				} satisfies CookingProfile,
			},
		);
		if (result.kind === "ready") setStatus("Saved.");
		else
			setStatus(
				result.kind === "signed_out"
					? "Sign in to save."
					: `Not saved. ${result.message}`,
			);
	};
	return (
		<form
			className="grid gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<p>
				{saved.profile === null
					? "Nobody has recorded these yet, so every hot or sharp step asks for a helper."
					: `Last changed ${new Date(saved.editedAt ?? "").toLocaleString()}.`}
			</p>
			{(Object.keys(tasks) as CookingTask[]).map((task) => (
				<label className="flex items-center justify-between gap-2" key={task}>
					<span>{tasks[task]}</span>
					<select
						className="win95-inset win95-field h-10 bg-white px-2 text-black"
						onChange={(event) =>
							setProfile({
								...profile,
								tasks: {
									...profile.tasks,
									[task]: event.target.value as TaskSupport,
								},
							})
						}
						value={profile.tasks[task]}
					>
						{(Object.keys(supports) as TaskSupport[]).map((s) => (
							<option key={s} value={s}>
								{supports[s]}
							</option>
						))}
					</select>
				</label>
			))}
			<label className="grid gap-1">
				<span>Foods they dislike (comma separated)</span>
				<input
					className="win95-inset win95-field h-10 bg-white px-2 text-black"
					onChange={(event) => setDislikes(event.target.value)}
					value={dislikes}
				/>
			</label>
			<Button className="h-11 justify-self-start" type="submit">
				Save cooking abilities
			</Button>
			{status !== null && <p role="status">{status}</p>}
		</form>
	);
}

/** What the wearer agreed to do alone in the kitchen. Needs care access (#26) to read or change. */
export function CookingAbilities({ familyId }: { familyId: string }) {
	const record = useApi(
		CookingProfileRecord,
		familyPath(familyId, "/cooking/profile"),
	);
	if (record.kind !== "ready")
		return <ApiNotice state={record} what="cooking abilities" />;
	return (
		<Editor
			familyId={familyId}
			key={record.value.editedAt ?? "none"}
			saved={record.value}
		/>
	);
}
