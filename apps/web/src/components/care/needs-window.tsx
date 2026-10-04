// Care needs and the family contact ladder (issue #30), shown on the care plan screen (#209). Every
// family client polls the same needs, so each shows the same state. Calls are simulated; Telly
// places no real calls or texts.
import {
	CareNeed,
	CareNeeds,
	type CareResponse,
	ContactLadderReply,
	type NewCareNeed,
} from "@health/contracts/care";
import { Me } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import { HeartHandshake } from "lucide-react";
import { useState } from "react";

import { LadderForm } from "@/components/care/ladder-form";
import { NeedCard } from "@/components/care/need-card";
import { Window } from "@/components/hud/window";
import { ApiNotice } from "@/components/win95";
import { apiRequest, familyPath, useApi } from "@/lib/api";

const POLL_MS = 5_000;
const field = "win95-inset win95-field h-11 min-w-0 bg-card px-2 text-sm";

export function CareNeedsWindow({ familyId }: { familyId: string }) {
	const meState = useApi(Me, "/api/me");
	const me = meState.kind === "ready" ? meState.value.identity : null;
	const base = familyPath(familyId, "/care");
	return (
		<Window
			title="Family help"
			icon={HeartHandshake}
			status="Calls are simulated. Only accepting and then confirming help closes a need."
		>
			<div className="grid gap-4 p-2 text-sm">
				<NeedsSection base={base} me={me} />
				<LadderSection base={base} me={me} />
			</div>
		</Window>
	);
}

/** The family's needs, polled so every family client shows the same state, and the ask form. */
function NeedsSection({ base, me }: { base: string; me: string | null }) {
	const [refreshKey, setRefreshKey] = useState(0);
	const refresh = () => setRefreshKey((key) => key + 1);
	const needs = useApi(CareNeeds, `${base}/needs`, {
		pollMs: POLL_MS,
		refreshKey,
	});
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const respond = async (
		needId: string,
		response: CareResponse["response"],
	) => {
		setBusy(needId);
		setError(null);
		const result = await apiRequest(
			CareNeed,
			`${base}/needs/${encodeURIComponent(needId)}/responses`,
			{ method: "POST", body: { response } satisfies CareResponse },
		);
		setBusy(null);
		if (result.kind === "ready") refresh();
		else
			setError(
				result.kind === "signed_out"
					? "Sign in to answer."
					: `Not sent: ${result.message}`,
			);
	};

	return (
		<>
			<section aria-labelledby="needs" className="grid gap-2">
				<h3 id="needs" className="font-bold">
					Care needs
				</h3>
				{error !== null && (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				)}
				{needs.kind !== "ready" ? (
					<ApiNotice state={needs} what="care needs" />
				) : needs.value.needs.length === 0 ? (
					<p>No care needs.</p>
				) : (
					needs.value.needs.map((need) => (
						<NeedCard
							key={need.id}
							need={need}
							me={me}
							busy={busy === need.id}
							onRespond={(response) => void respond(need.id, response)}
						/>
					))
				)}
			</section>
			<section aria-labelledby="ask" className="grid gap-2">
				<h3 id="ask" className="font-bold">
					Ask the family
				</h3>
				<NewNeedForm path={`${base}/needs`} onSaved={refresh} />
			</section>
		</>
	);
}

function LadderSection({ base, me }: { base: string; me: string | null }) {
	const [refreshKey, setRefreshKey] = useState(0);
	const ladder = useApi(ContactLadderReply, `${base}/ladder`, { refreshKey });
	return (
		<section aria-labelledby="ladder" className="grid gap-2">
			<h3 id="ladder" className="font-bold">
				Contact ladder
			</h3>
			{ladder.kind !== "ready" ? (
				<ApiNotice state={ladder} what="the contact ladder" />
			) : (
				<LadderForm
					key={ladder.value.ladder?.updatedAt ?? "none"}
					path={`${base}/ladder`}
					ladder={ladder.value.ladder}
					me={me}
					onSaved={() => setRefreshKey((key) => key + 1)}
				/>
			)}
		</section>
	);
}

function NewNeedForm({ path, onSaved }: { path: string; onSaved: () => void }) {
	const [kind, setKind] = useState<NewCareNeed["kind"]>("help");
	const [summary, setSummary] = useState("");
	const [due, setDue] = useState("");
	// One id per need, kept across resends, so a retry after a lost reply is stored once.
	const [clientId, setClientId] = useState(() => crypto.randomUUID());
	const [status, setStatus] = useState("");
	const send = async () => {
		setStatus("Sending…");
		const result = await apiRequest(CareNeed, path, {
			method: "POST",
			body: {
				clientId,
				kind,
				summary: summary.trim(),
				sampleIds: [],
				dueAt: due === "" ? null : new Date(due).toISOString(),
			} satisfies NewCareNeed,
		});
		if (result.kind !== "ready") {
			setStatus(
				result.kind === "signed_out"
					? "Sign in to ask."
					: `Not sent: ${result.message}`,
			);
			return;
		}
		setStatus("Sent to the first contact.");
		setSummary("");
		setDue("");
		setClientId(crypto.randomUUID());
		onSaved();
	};
	return (
		<form
			className="grid gap-2 sm:grid-cols-[auto_1fr]"
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<label className="grid gap-1">
				Kind
				<select
					className={field}
					value={kind}
					onChange={(e) => setKind(e.target.value as NewCareNeed["kind"])}
				>
					<option value="help">Request for help</option>
					<option value="call_reminder">Call reminder</option>
				</select>
			</label>
			<label className="grid gap-1">
				What is needed
				<input
					className={field}
					value={summary}
					maxLength={500}
					onChange={(e) => setSummary(e.target.value)}
				/>
			</label>
			<label className="grid gap-1">
				Not before (optional)
				<input
					type="datetime-local"
					className={field}
					value={due}
					onChange={(e) => setDue(e.target.value)}
				/>
			</label>
			<div className="flex items-end gap-2">
				<Button type="submit" className="h-11" disabled={summary.trim() === ""}>
					Ask
				</Button>
				<p role="status" className="text-xs">
					{status}
				</p>
			</div>
		</form>
	);
}
