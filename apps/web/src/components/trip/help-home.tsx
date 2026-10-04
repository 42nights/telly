// "Help me get home" (issue #40): one tap asks the family through the care ladder, one tap calls
// Mom, and Directions home uses the saved home position (#302) or the typed address.
import { CareNeed } from "@health/contracts/care";
import type { HomeWatch } from "@health/contracts/location";
import { Button, buttonVariants } from "@health/ui/components/button";
import { useRef, useState } from "react";

import { SpeechLine, useSpeech } from "@/components/wearer/speech";
import { apiRequest, familyPath } from "@/lib/api";
import { telHref, useContacts } from "@/lib/contacts";

import { directionsUrl, HOME_ADDRESS_KEY, helpMessage } from "./logic";

const big = "h-14 text-[18px]";

type Help =
	| { readonly kind: "idle" | "sending" }
	| { readonly kind: "sent" | "failed"; readonly message: string };

export function HelpHome({
	familyId,
	watch,
}: {
	familyId: string | null;
	watch: HomeWatch | null;
}) {
	const { speech, say } = useSpeech(familyId);
	const [contacts] = useContacts();
	const [help, setHelp] = useState<Help>({ kind: "idle" });
	// One id per help request, reused by a retry, so the family ladder opens one need.
	const clientId = useRef<string | null>(null);
	const address = localStorage.getItem(HOME_ADDRESS_KEY)?.trim() ?? "";
	const homeTarget = watch?.home ?? (address === "" ? null : address);

	const ask = async () => {
		if (familyId === null) {
			setHelp({
				kind: "failed",
				message: "No family is set up on this device.",
			});
			return;
		}
		clientId.current ??= crypto.randomUUID();
		setHelp({ kind: "sending" });
		const result = await apiRequest(
			CareNeed,
			familyPath(familyId, "/care/needs"),
			{
				method: "POST",
				body: {
					clientId: clientId.current,
					kind: "help",
					summary: helpMessage(
						watch?.awaySince ?? null,
						watch?.sharing ?? false,
					),
					sampleIds: [],
					dueAt: null,
				},
			},
		);
		if (result.kind === "ready") {
			clientId.current = null;
			const contact = result.value.attempts.at(-1);
			const message =
				contact === undefined
					? "Nobody is set up to be contacted yet. Your request stays open on the Care page. Call instead."
					: `I asked ${contact.name}. Telly keeps asking your family until someone says they will help.`;
			setHelp({ kind: "sent", message });
			void say("help", message);
		} else
			setHelp({
				kind: "failed",
				message:
					result.kind === "signed_out"
						? "Not sent. Sign in again, or call instead."
						: `Not sent: ${result.message} Call instead.`,
			});
	};

	return (
		<section aria-labelledby="help" className="grid gap-2">
			<h3 id="help" className="font-bold">
				Help me get home
			</h3>
			<Button
				className={`${big} win95-primary`}
				disabled={help.kind === "sending"}
				onClick={() => void ask()}
			>
				{help.kind === "failed"
					? "Try again: tell my family"
					: "Tell my family I need help"}
			</Button>
			<p aria-live="polite" className="text-[16px]">
				{help.kind === "sending" && "Sending…"}
				{help.kind === "sent" && help.message}
			</p>
			{help.kind === "failed" && (
				<p className="font-bold text-[16px] text-destructive" role="alert">
					{help.message}
				</p>
			)}
			{speech.key === "help" && <SpeechLine speech={speech} />}
			<div className="grid grid-cols-2 gap-2">
				{contacts.momPhone === null ? (
					<p
						className={`text-[16px] ${homeTarget === null ? "col-span-2" : ""}`}
					>
						Add Mom's number in Settings to call her here.
					</p>
				) : (
					<a
						className={buttonVariants({ className: big, variant: "outline" })}
						data-slot="button"
						href={telHref(contacts.momPhone)}
					>
						Call Mom
					</a>
				)}
				{homeTarget !== null && (
					<a
						className={buttonVariants({ className: big, variant: "outline" })}
						data-slot="button"
						href={directionsUrl(homeTarget)}
						rel="noreferrer"
						target="_blank"
					>
						Directions home
					</a>
				)}
			</div>
		</section>
	);
}
