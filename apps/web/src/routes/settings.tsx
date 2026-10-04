import { createFileRoute } from "@tanstack/react-router";

import { SpeakerSettingsWindow } from "@/components/reminders/speaker-settings";
import { MedicineMemorySettings } from "@/components/settings/medicine-memory";
import { ReportEmailSettingsWindow } from "@/components/settings/report-email";
import { SettingsForm } from "@/components/settings/settings-form";

export const Route = createFileRoute("/settings")({
	component: () => (
		<main className="mx-auto grid w-full max-w-xl gap-4 p-2 md:p-6">
			<SettingsForm />
			<SpeakerSettingsWindow />
			<MedicineMemorySettings />
			<ReportEmailSettingsWindow />
		</main>
	),
});
