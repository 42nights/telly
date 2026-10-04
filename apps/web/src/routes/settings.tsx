import { createFileRoute } from "@tanstack/react-router";

import { SpeakerSettingsWindow } from "@/components/reminders/speaker-settings";
import { SettingsForm } from "@/components/settings/settings-form";

export const Route = createFileRoute("/settings")({
	component: () => (
		<main className="mx-auto grid w-full max-w-xl gap-4 p-2 md:p-6">
			<SettingsForm />
			<SpeakerSettingsWindow />
		</main>
	),
});
