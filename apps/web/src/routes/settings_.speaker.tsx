import { createFileRoute } from "@tanstack/react-router";

import { SpeakerSettingsWindow } from "@/components/reminders/speaker-settings";

export const Route = createFileRoute("/settings_/speaker")({
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<SpeakerSettingsWindow />
		</main>
	),
});
