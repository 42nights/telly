// Invite someone to a family (#316): one join link from `POST /invites`, shown with Share and Copy.
// The onboarding Connect step, Settings › Family, and the family view all use it.
import { FamilyInvite, FamilyMembers } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import { UserPlus } from "lucide-react";
import { useState } from "react";

import { failureText } from "@/components/onboarding/logic";
import { ShareLink } from "@/components/onboarding/share-link";
import { ApiNotice, Tip } from "@/components/win95";
import { apiRequest, familyPath, useApi } from "@/lib/api";
import { memberLabel } from "@/lib/members";

/** Creates join links for one family. `create` answers the failure text, or null on success. */
export function useInvite(familyId: string) {
	const [link, setLink] = useState<string | null>(null);
	const create = async (): Promise<string | null> => {
		const result = await apiRequest(
			FamilyInvite,
			familyPath(familyId, "/invites"),
			{ method: "POST" },
		);
		if (result.kind !== "ready") return failureText(result);
		setLink(`${location.origin}/join/${encodeURIComponent(result.value.code)}`);
		return null;
	};
	return { link, create };
}

export function InviteLink({
	link,
	familyName,
}: {
	link: string;
	familyName: string;
}) {
	return (
		<div className="grid gap-1">
			<p className="flex items-center gap-1 text-xs">
				Send this link to join {familyName}.
				<Tip
					align="end"
					text="The person signs in with Google. The link works once and ends in 7 days. Joined people get no care permissions until you grant them (Care plan → Sharing)."
				/>
			</p>
			<ShareLink link={link} title={`Join ${familyName}`} />
		</div>
	);
}

/** Who is in the family, by the name each signed in with, and an "Invite someone" button. */
export function FamilyPeople({
	familyId,
	familyName,
	me,
}: {
	familyId: string;
	familyName: string;
	me: string | null;
}) {
	const members = useApi(FamilyMembers, familyPath(familyId, "/members"));
	const invite = useInvite(familyId);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const send = async () => {
		setBusy(true);
		setError(null);
		setError(await invite.create());
		setBusy(false);
	};
	return (
		<div className="grid gap-2">
			{/* One line: the chips scroll sideways when there are many (captain: chips on one line). */}
			<div className="flex items-center gap-2">
				{members.kind === "ready" ? (
					<ul
						aria-label="Family members"
						className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
					>
						{members.value.members.map(({ identity, name }) => (
							<li
								key={identity}
								className="win95-inset shrink-0 whitespace-nowrap bg-card px-2 py-1"
							>
								{name === null
									? memberLabel(identity, me)
									: identity === me
										? `${name} (you)`
										: name}
							</li>
						))}
					</ul>
				) : (
					<ApiNotice state={members} what="family members" />
				)}
				<Button
					type="button"
					className="h-11 shrink-0 px-3"
					disabled={busy}
					onClick={() => void send()}
				>
					<UserPlus aria-hidden className="size-4" />
					Invite someone
				</Button>
			</div>
			{error !== null && <p role="alert">{error}</p>}
			{invite.link !== null && (
				<InviteLink link={invite.link} familyName={familyName} />
			)}
		</div>
	);
}
