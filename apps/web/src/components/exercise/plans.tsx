// The family's side of guided exercise (#41): record an activity the wearer agreed to, confirm it
// matches its source, and read each session's outcome. Only a confirmed plan is offered to the
// wearer, and a plan that needs a restricted demand cannot be saved.
import {
	ExerciseDemand,
	ExercisePlan,
	type ExercisePlanInput,
	ExerciseRecords,
} from "@health/contracts/exercise";
import { Button } from "@health/ui/components/button";
import { useState } from "react";

import { ApiNotice } from "@/components/win95";
import { apiRequest, familyPath, useApi } from "@/lib/api";

import { demandText, outcomeText, reasonText } from "./logic";

const demands = ExerciseDemand.literals;
const field = "win95-inset win95-field h-10 min-w-0 bg-white px-2 text-black";

function DemandBoxes({
	legend,
	value,
	onChange,
}: {
	legend: string;
	value: readonly ExerciseDemand[];
	onChange: (next: ExerciseDemand[]) => void;
}) {
	return (
		<fieldset className="grid gap-1">
			<legend className="font-semibold">{legend}</legend>
			{demands.map((demand) => (
				<label className="flex items-center gap-2" key={demand}>
					<input
						checked={value.includes(demand)}
						onChange={(event) =>
							onChange(
								event.target.checked
									? [...value, demand]
									: value.filter((d) => d !== demand),
							)
						}
						type="checkbox"
					/>
					{demandText[demand]}
				</label>
			))}
		</fieldset>
	);
}

function PlanForm({
	familyId,
	onSaved,
}: {
	familyId: string;
	onSaved: () => void;
}) {
	const [activity, setActivity] = useState("");
	const [steps, setSteps] = useState("");
	const [needs, setNeeds] = useState<ExerciseDemand[]>([]);
	const [avoid, setAvoid] = useState<ExerciseDemand[]>([]);
	const [source, setSource] = useState("");
	const [windowStart, setWindowStart] = useState("09:00");
	const [windowEnd, setWindowEnd] = useState("11:00");
	const [videoUrl, setVideoUrl] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const conflicts = needs.filter((d) => avoid.includes(d));

	return (
		<form
			className="grid gap-2"
			onSubmit={async (event) => {
				event.preventDefault();
				const [first, ...rest] = steps
					.split("\n")
					.map((s) => s.trim())
					.filter((s) => s !== "");
				if (first === undefined) return setProblem("Write at least one step.");
				const body: ExercisePlanInput = {
					activity: activity.trim(),
					steps: [first, ...rest],
					demands: needs,
					restrictions: avoid,
					source: source.trim(),
					windowStart,
					windowEnd,
					videoUrl: videoUrl.trim() === "" ? null : videoUrl.trim(),
				};
				const result = await apiRequest(
					ExercisePlan,
					familyPath(familyId, "/exercise/plans"),
					{ method: "POST", body },
				);
				if (result.kind === "ready") onSaved();
				else
					setProblem(
						result.kind === "signed_out"
							? "Sign in to save the activity."
							: result.message,
					);
			}}
		>
			<label className="grid gap-1">
				Activity name
				<input
					className={field}
					maxLength={80}
					onChange={(e) => setActivity(e.target.value)}
					required
					value={activity}
				/>
			</label>
			<label className="grid gap-1">
				Steps, one per line, exactly as written in the source
				<textarea
					className="win95-inset win95-field min-h-24 bg-white p-2 text-black"
					onChange={(e) => setSteps(e.target.value)}
					required
					value={steps}
				/>
			</label>
			<label className="grid gap-1">
				Where it was agreed (for example, a physiotherapist's handout)
				<input
					className={field}
					maxLength={200}
					onChange={(e) => setSource(e.target.value)}
					required
					value={source}
				/>
			</label>
			<DemandBoxes
				legend="The activity needs"
				onChange={setNeeds}
				value={needs}
			/>
			<DemandBoxes
				legend="The wearer's recorded restrictions"
				onChange={setAvoid}
				value={avoid}
			/>
			{conflicts.length > 0 && (
				<p className="text-destructive" role="alert">
					A restriction forbids:{" "}
					{conflicts.map((d) => demandText[d]).join(", ")}. Choose another
					activity.
				</p>
			)}
			<div className="grid grid-cols-2 gap-2">
				<label className="grid gap-1">
					Invite from
					<input
						className={field}
						onChange={(e) => setWindowStart(e.target.value)}
						required
						type="time"
						value={windowStart}
					/>
				</label>
				<label className="grid gap-1">
					Until
					<input
						className={field}
						onChange={(e) => setWindowEnd(e.target.value)}
						required
						type="time"
						value={windowEnd}
					/>
				</label>
			</div>
			<label className="grid gap-1">
				Video from the same source (https, optional)
				<input
					className={field}
					onChange={(e) => setVideoUrl(e.target.value)}
					pattern="https://\S+"
					type="url"
					value={videoUrl}
				/>
			</label>
			{problem !== null && (
				<p className="text-destructive" role="alert">
					{problem}
				</p>
			)}
			<Button className="h-11" disabled={conflicts.length > 0} type="submit">
				Save activity
			</Button>
		</form>
	);
}

/** Agreed activities and the wearer's session history for one family. */
export function ExerciseSection({ familyId }: { familyId: string }) {
	const [adding, setAdding] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const records = useApi(ExerciseRecords, familyPath(familyId, "/exercise"), {
		pollMs: 30_000,
	});
	if (records.kind !== "ready")
		return <ApiNotice state={records} what="exercise" />;
	const { plans, sessions } = records.value;

	return (
		<div className="win95-inset grid gap-3 bg-card p-2">
			{plans.length === 0 && <p>No agreed activity yet.</p>}
			<ul className="grid gap-2">
				{plans.map((plan) => (
					<li className="grid gap-1" key={plan.id}>
						<p>
							<b>{plan.activity}</b> · {plan.windowStart}–{plan.windowEnd}
						</p>
						<p className="text-muted-foreground">Source: {plan.source}</p>
						{plan.verification === null ? (
							<Button
								className="h-10 justify-self-start"
								variant="outline"
								onClick={async () => {
									const result = await apiRequest(
										ExercisePlan,
										familyPath(familyId, `/exercise/plans/${plan.id}/verify`),
										{ method: "POST" },
									);
									if (result.kind !== "ready")
										setProblem(
											result.kind === "signed_out"
												? "Sign in to confirm the activity."
												: result.message,
										);
								}}
							>
								Not offered yet: confirm it matches the source
							</Button>
						) : (
							<p>Confirmed. It is offered during its time window.</p>
						)}
					</li>
				))}
			</ul>
			{problem !== null && (
				<p className="text-destructive" role="alert">
					{problem}
				</p>
			)}
			<h4 className="font-bold">Sessions</h4>
			{sessions.length === 0 ? (
				<p>No sessions recorded yet. No answer is not counted as exercise.</p>
			) : (
				<ul className="grid gap-1">
					{sessions.map((s) => (
						<li key={s.sessionId}>
							{new Date(s.openedAt).toLocaleString()} ·{" "}
							{plans.find((p) => p.id === s.planId)?.activity ??
								"Unknown activity"}
							: <b>{outcomeText[s.outcome]}</b>
							{s.reason === null ? "" : ` (${reasonText[s.reason]})`}
							{s.help ? " · asked for help" : ""}
						</li>
					))}
				</ul>
			)}
			{adding ? (
				<PlanForm familyId={familyId} onSaved={() => setAdding(false)} />
			) : (
				<Button
					className="h-11 justify-self-start"
					variant="outline"
					onClick={() => setAdding(true)}
				>
					Add an agreed activity
				</Button>
			)}
		</div>
	);
}
