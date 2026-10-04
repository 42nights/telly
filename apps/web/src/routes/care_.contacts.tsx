// Care › Contacts (issue #30): the family contact ladder, in the order Telly asks people for help.
import { ContactLadderReply } from "@health/contracts/care";
import { createFileRoute } from "@tanstack/react-router";
import { PhoneForwarded } from "lucide-react";
import { useState } from "react";

import { LadderForm } from "@/components/care/ladder-form";
import { CareScreen } from "@/components/care/screen";
import { ApiNotice } from "@/components/win95";
import { useApi } from "@/lib/api";

export const Route = createFileRoute("/care_/contacts")({
	component: () => (
		<CareScreen title="Contact ladder" icon={PhoneForwarded}>
			{(base, me) => <LadderSection base={base} me={me} />}
		</CareScreen>
	),
});

function LadderSection({ base, me }: { base: string; me: string | null }) {
	const [refreshKey, setRefreshKey] = useState(0);
	const ladder = useApi(ContactLadderReply, `${base}/ladder`, { refreshKey });
	return ladder.kind !== "ready" ? (
		<ApiNotice state={ladder} what="the contact ladder" />
	) : (
		<LadderForm
			key={ladder.value.ladder?.updatedAt ?? "none"}
			path={`${base}/ladder`}
			ladder={ladder.value.ladder}
			me={me}
			onSaved={() => setRefreshKey((key) => key + 1)}
		/>
	);
}
