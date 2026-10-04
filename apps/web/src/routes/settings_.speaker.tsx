import { SavedSpeakerSettings } from "@health/contracts/speaker";
import { createFileRoute } from "@tanstack/react-router";

import { SpeakerSettingsWindow } from "@/components/reminders/speaker-settings";
import { familyPath } from "@/lib/api";
import { loadFamilyReads } from "@/lib/family";

export const Route = createFileRoute("/settings_/speaker")({
	loader: loadFamilyReads((familyId) => [
		[SavedSpeakerSettings, familyPath(familyId, "/speaker-settings")],
	]),
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<SpeakerSettingsWindow />
		</main>
	),
});
