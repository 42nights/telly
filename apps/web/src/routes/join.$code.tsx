import { JoinedFamily } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { UserPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { Window } from "@/components/hud/window";
import { PENDING_JOIN } from "@/components/onboarding/redirect";
import { apiRequest } from "@/lib/api";
import { useFamily } from "@/lib/family";
import { getSessionToken } from "@/lib/session";

export const Route = createFileRoute("/join/$code")({
	component: Join,
});

const BAD_LINK =
	"This invite link is used, ended, or wrong. Ask for a new one.";

function Join() {
	const { code } = Route.useParams();
	const navigate = Route.useNavigate();
	const { select, reload } = useFamily();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Signed out: keep the code and sign in first; sign-in comes back here. Signed in: the code is
	// in the address, so it is no longer pending.
	useEffect(() => {
		if (getSessionToken() === null) {
			localStorage.setItem(PENDING_JOIN, code);
			void navigate({ to: "/sign-in" });
		} else localStorage.removeItem(PENDING_JOIN);
	}, [code, navigate]);

	const join = async () => {
		setBusy(true);
		const result = await apiRequest(
			JoinedFamily,
			`/api/invites/${encodeURIComponent(code)}/join`,
			{ method: "POST" },
		);
		setBusy(false);
		if (result.kind === "ready") {
			select(result.value.family.id);
			reload();
			return navigate({ to: "/hud" });
		}
		if (result.kind === "signed_out") {
			localStorage.setItem(PENDING_JOIN, code);
			return navigate({ to: "/sign-in" });
		}
		setError(
			result.kind === "unavailable" ||
				(result.kind === "error" && result.unreachable)
				? result.message
				: BAD_LINK,
		);
	};

	return (
		<main className="mx-auto w-full max-w-[480px] p-2 md:p-6">
			<Window title="Join a family" icon={UserPlus}>
				<div className="grid gap-3 p-2">
					<p>
						Someone invited you to their family on Telly. You join with no care
						permissions; they grant them later.
					</p>
					{error !== null && <p role="alert">{error}</p>}
					<Button
						type="button"
						className="win95-primary h-11 w-full"
						disabled={busy}
						onClick={() => void join()}
					>
						{busy ? "Joining…" : "Join a family"}
					</Button>
				</div>
			</Window>
		</main>
	);
}
