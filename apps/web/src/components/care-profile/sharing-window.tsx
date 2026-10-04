import { type CareAccess, CareScope } from "@health/contracts/care-profile";
import { Button } from "@health/ui/components/button";
import { Share2 } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { memberLabel } from "@/lib/members";

import type { CareData } from "./data";

const label: Record<CareScope, string> = {
	health_records: "Health records",
	care_plan_edit: "Edit the care plan",
	family_access: "Manage sharing",
	location: "Location",
	media: "Photos and audio",
	clinician_delivery: "Send to clinicians",
	purchases: "Purchases",
};

const IDENTITY = /^[0-9a-f]{64}$/;

/** A new family: its founder grants themselves the care plan scopes. The server refuses anyone else. */
function SetUp({
	access,
	care,
	onMessage,
}: {
	access: CareAccess;
	care: CareData;
	onMessage: (message: string) => void;
}) {
	const { me } = care;
	if (access.history.length > 0 || me === null)
		return <p>Nobody has access now.</p>;
	return (
		<div className="grid gap-1">
			<p>
				Nobody has access yet. The person who created this family sets up
				sharing.
			</p>
			<Button
				type="button"
				className="win95-primary h-11 justify-self-start px-4 text-sm"
				onClick={async () => {
					for (const scope of [
						"family_access",
						"health_records",
						"care_plan_edit",
					]) {
						const refused = await care.write("POST", "/care-access", {
							identity: me,
							scope,
							granted: true,
						});
						if (refused !== null) return onMessage(refused);
					}
					onMessage("Sharing is set up. You can now grant access to others.");
				}}
			>
				Set up sharing as the family's creator
			</Button>
		</div>
	);
}

/** Per-recipient sharing: each scope is granted to one member at a time; membership alone grants nothing. */
export function SharingWindow({
	access,
	care,
}: {
	access: CareAccess;
	care: CareData;
}) {
	const [identity, setIdentity] = useState("");
	const [scope, setScope] = useState<CareScope>("health_records");
	const [message, setMessage] = useState<string | null>(null);
	const canManage = access.mine.includes("family_access");
	const change = async (who: string, what: CareScope, granted: boolean) => {
		const refused = await care.write("POST", "/care-access", {
			identity: who,
			scope: what,
			granted,
		});
		setMessage(refused ?? (granted ? "Access granted." : "Access revoked."));
	};
	const members = [...new Set(access.grants.map((g) => g.identity))];
	return (
		<Window
			title="Sharing"
			icon={Share2}
			status={
				message ??
				(access.mine.length === 0
					? "You have no care access in this family."
					: `Your access: ${access.mine.map((s) => label[s]).join(", ")}`)
			}
		>
			<div className="grid gap-2 p-2 text-sm">
				<p>
					Being family grants no access. Each person sees and does only what is
					granted here. A revoke stops their next read.
				</p>
				{members.length === 0 ? (
					<SetUp access={access} care={care} onMessage={setMessage} />
				) : (
					<ul className="grid gap-2">
						{members.map((who) => (
							<li key={who} className="win95-inset grid gap-1 bg-card p-2">
								<b>{memberLabel(who, care.me)}</b>
								<ul className="flex flex-wrap gap-1">
									{access.grants
										.filter((g) => g.identity === who)
										.map((g) => (
											<li key={g.scope} className="flex items-center gap-1">
												<span className="win95-raised px-2 py-1">
													{label[g.scope]}
												</span>
												{canManage && (
													<Button
														type="button"
														className="h-11 px-3 text-sm"
														aria-label={`Revoke ${label[g.scope]} from ${memberLabel(who, care.me)}`}
														onClick={() => change(who, g.scope, false)}
													>
														Revoke
													</Button>
												)}
											</li>
										))}
								</ul>
							</li>
						))}
					</ul>
				)}
				{canManage && (
					<form
						aria-label="Grant access"
						className="grid gap-2 border border-border p-2"
						onSubmit={(event) => {
							event.preventDefault();
							if (IDENTITY.test(identity.trim()))
								void change(identity.trim(), scope, true);
						}}
					>
						<label htmlFor="grant-identity" className="font-bold">
							Family member identity
						</label>
						<input
							id="grant-identity"
							className="win95-inset win95-field h-11 bg-card px-2 font-mono"
							value={identity}
							aria-describedby="grant-identity-hint"
							onChange={(event) => setIdentity(event.target.value)}
						/>
						<small id="grant-identity-hint">
							The 64-character identity the member sees after sign-in.
						</small>
						<label htmlFor="grant-scope" className="font-bold">
							Access
						</label>
						<select
							id="grant-scope"
							className="win95-inset win95-field h-11 bg-card px-2"
							value={scope}
							onChange={(event) => setScope(event.target.value as CareScope)}
						>
							{CareScope.literals.map((s) => (
								<option key={s} value={s}>
									{label[s]}
								</option>
							))}
						</select>
						<Button
							type="submit"
							className="win95-primary h-11 justify-self-end px-6 text-sm"
							disabled={!IDENTITY.test(identity.trim())}
						>
							Grant
						</Button>
					</form>
				)}
			</div>
		</Window>
	);
}
