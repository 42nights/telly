import { Button } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { LogOut, Users } from "lucide-react";
import { useRef } from "react";

import { SettingsForm } from "@/components/settings/settings-form";
import { SignOutDialog } from "@/components/shell";
import { setView, useView } from "@/lib/view";

// Settings › Phone numbers. The other tabs: Home speaker, Going out, Saved things, Report email,
// This device, Family. In the wearer view, the view switch and Sign out are here, not in the menu.
export const Route = createFileRoute("/settings")({
	component: Settings,
});

function Settings() {
	const view = useView();
	const signOut = useRef<HTMLDialogElement>(null);
	return (
		<main className="mx-auto grid w-full max-w-xl gap-2 p-2">
			{view === "wearer" && (
				<div className="grid grid-cols-2 gap-2">
					<Button className="h-11" onClick={() => setView("family")}>
						<Users aria-hidden /> Switch to family view
					</Button>
					<Button className="h-11" onClick={() => signOut.current?.showModal()}>
						<LogOut aria-hidden /> Sign out…
					</Button>
					<SignOutDialog ref={signOut} />
				</div>
			)}
			<SettingsForm />
		</main>
	);
}
