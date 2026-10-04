import { createFileRoute } from "@tanstack/react-router";

import { MyPhone } from "@/components/settings/my-phone";

export const Route = createFileRoute("/settings_/text-telly")({
	component: () => (
		<main className="mx-auto w-full max-w-xl p-2 md:p-6">
			<MyPhone />
		</main>
	),
});
