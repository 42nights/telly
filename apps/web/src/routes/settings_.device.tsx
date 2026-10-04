// Settings › This device: who uses this device. The choice sets the start screen, the pinned
// taskbar buttons, and the size of the menu, on this device only.
import { createFileRoute } from "@tanstack/react-router";
import { MonitorSmartphone } from "lucide-react";

import { Window } from "@/components/hud/window";
import { setView, useView, type View } from "@/lib/view";

export const Route = createFileRoute("/settings_/device")({
	component: ThisDevice,
});

const choices = [
	{
		view: "wearer",
		label: "The wearer",
		detail: "Home first. Big buttons for Home, Medicine, and Going out.",
	},
	{
		view: "family",
		label: "A family member",
		detail: "Family first. Buttons for Family, Chat, and Reports.",
	},
] as const satisfies ReadonlyArray<{
	view: View;
	label: string;
	detail: string;
}>;

function ThisDevice() {
	const view = useView();
	return (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<Window
				title="Settings · This device"
				icon={MonitorSmartphone}
				status="Saved on this device only."
			>
				<fieldset className="grid gap-1 p-2 text-sm">
					<legend className="font-bold">Who uses this device?</legend>
					{choices.map((choice) => (
						<label
							key={choice.view}
							className="flex min-h-11 items-start gap-3 py-2"
						>
							<input
								type="radio"
								name="view"
								className="mt-0.5 size-5 shrink-0 accent-primary [color-scheme:light]"
								checked={view === choice.view}
								onChange={() => setView(choice.view)}
							/>
							<span>
								<b>{choice.label}</b>
								<br />
								{choice.detail}
							</span>
						</label>
					))}
				</fieldset>
			</Window>
		</main>
	);
}
