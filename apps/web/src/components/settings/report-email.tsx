import { EmailAddress, ReportEmailSettings } from "@health/contracts/reports";
import { Button } from "@health/ui/components/button";
import { Schema } from "effect";
import { Mail } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { ApiNotice } from "@/components/win95";
import { type ApiResult, apiRequest, familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

/** The family's report email (#8): one address, and whether a review emails the report to it. */
export function ReportEmailSettingsWindow() {
	const { family } = useFamily();
	const path = family === null ? null : familyPath(family.id, "/report-email");
	const settings = useApi(ReportEmailSettings, path);
	return (
		<Window
			icon={Mail}
			status={
				settings.kind !== "ready"
					? undefined
					: settings.value.enabled
						? `On · reviewed reports go to ${settings.value.recipient}`
						: "Off: reviewed reports are not emailed"
			}
			title="Settings · Report email"
		>
			{settings.kind === "ready" ? (
				<EmailForm
					key={settings.at}
					saved={settings.value}
					save={async (value) => {
						if (path === null)
							return { kind: "error", message: "No person is paired yet." };
						return apiRequest(ReportEmailSettings, path, {
							method: "PUT",
							body: value,
						});
					}}
				/>
			) : (
				<ApiNotice state={settings} what="report email" />
			)}
		</Window>
	);
}

function EmailForm({
	saved,
	save,
}: {
	saved: ReportEmailSettings;
	save: (value: ReportEmailSettings) => Promise<ApiResult<ReportEmailSettings>>;
}) {
	const [enabled, setEnabled] = useState(saved.enabled);
	const [recipient, setRecipient] = useState(saved.recipient ?? "");
	const [result, setResult] = useState<ApiResult<unknown> | null>(null);
	const address = recipient.trim();
	const error =
		address === ""
			? enabled
				? "Enter the email address that gets the reports"
				: null
			: Schema.is(EmailAddress)(address)
				? null
				: "Enter a full email address, like name@example.com";
	return (
		<form
			aria-label="Report email"
			className="grid gap-3 p-2 text-sm"
			onSubmit={(event) => {
				event.preventDefault();
				void save({ enabled, recipient: address || null }).then(setResult);
			}}
		>
			<label className="flex min-h-11 items-center gap-2">
				<input
					checked={enabled}
					className="size-5"
					onChange={(event) => setEnabled(event.target.checked)}
					type="checkbox"
				/>
				Automatically email reviewed reports
			</label>
			<p>
				When a family member marks a lab report as reviewed, Telly emails its
				PDF to this address once. Each report also has a "Send by email" button.
				Only a family admin can change this.
			</p>
			<label className="grid gap-1">
				Recipient email
				<input
					aria-describedby={error === null ? undefined : "report-email-error"}
					aria-invalid={error !== null}
					autoComplete="email"
					className="win95-inset win95-field h-11 w-full bg-card px-2 text-base"
					onChange={(event) => setRecipient(event.target.value)}
					type="email"
					value={recipient}
				/>
			</label>
			{error !== null && (
				<p className="text-destructive" id="report-email-error">
					{error}
				</p>
			)}
			{result !== null && result.kind !== "ready" && (
				<p className="font-bold text-destructive" role="alert">
					Not saved:{" "}
					{result.kind === "signed_out" ? "sign in first." : result.message}
				</p>
			)}
			<Button
				className="win95-primary h-11 justify-self-end px-6 text-sm"
				disabled={error !== null}
				type="submit"
			>
				Save
			</Button>
		</form>
	);
}
