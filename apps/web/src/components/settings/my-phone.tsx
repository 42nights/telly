// Settings › My phone number (#370). Telly's iMessage agent answers texts from the number each
// member saves here, in that member's family. The server keeps it; one person per number.
import { TextTelly } from "@health/contracts/families";
import { Button } from "@health/ui/components/button";
import { MessageCircle } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { TextTellyButton } from "@/components/text-telly";
import { apiRequest, reread, useApi } from "@/lib/api";
import { toE164 } from "@/lib/contacts";

const PATH = "/api/text-telly";

function PhoneForm({ saved }: { saved: string | null }) {
	const [value, setValue] = useState(saved ?? "");
	const [status, setStatus] = useState<string | null>(null);
	const blank = value.trim() === "";
	const next = blank ? null : toE164(value);
	const valid = blank || next !== null;
	const changed = next !== saved;
	return (
		<form
			aria-label="My phone number"
			className="grid gap-2"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!valid || !changed) return;
				setStatus("Saving…");
				const result = await apiRequest(null, "/api/me/phone", {
					method: "PUT",
					body: { phone: next },
				});
				if (result.kind !== "ready")
					return setStatus(
						"message" in result ? result.message : "Sign in to save it.",
					);
				setStatus(next === null ? "Removed." : "Saved.");
				await reread(PATH);
			}}
		>
			<label htmlFor="settings-my-phone">My phone number</label>
			<input
				id="settings-my-phone"
				type="tel"
				autoComplete="tel"
				className="win95-inset win95-field h-11 w-full bg-card px-2 text-base"
				value={value}
				placeholder="Telly does not answer you until you add it"
				aria-invalid={!valid}
				aria-describedby={valid ? undefined : "settings-my-phone-error"}
				onChange={(event) => {
					setValue(event.target.value);
					setStatus(null);
				}}
			/>
			{!valid && (
				<p id="settings-my-phone-error" className="font-bold text-destructive">
					Enter a full phone number, like (555) 010-0123 or +44 20 7946 0123
				</p>
			)}
			<Button
				type="submit"
				className="win95-primary h-11"
				disabled={!valid || !changed}
			>
				Save my number
			</Button>
			{status !== null && <p role="status">{status}</p>}
		</form>
	);
}

/** My phone number, with the Text Telly button. */
export function MyPhone() {
	const state = useApi(TextTelly, PATH);
	return (
		<Window title="Settings · Text Telly" icon={MessageCircle}>
			<div className="grid gap-3 p-2 text-sm">
				<p>
					Text Telly from your phone to ask about medicines, reminders, and
					where things are. Telly answers the number you save here.
				</p>
				{state.kind === "ready" ? (
					<PhoneForm saved={state.value.myPhone} />
				) : (
					<p>
						{state.kind === "loading"
							? "Loading your number…"
							: state.kind === "signed_out"
								? "Sign in to save your number."
								: `Not available: ${state.message}`}
					</p>
				)}
				<TextTellyButton />
			</div>
		</Window>
	);
}
