import { createFileRoute, redirect } from "@tanstack/react-router";

import { homePath } from "@/components/shell/screens";
import { getView } from "@/lib/view";

// The start screen is this device's view home: Home for the wearer, Family for a family member.
export const Route = createFileRoute("/")({
	beforeLoad: () => {
		throw redirect({ to: homePath(getView()) });
	},
});
