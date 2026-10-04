// "Text Telly" (#370): a button that opens the Telly line's iMessage number with Message Telly,
// Add to Contacts, and Copy. Telly answers texts from the phone number a member saved in Settings.
import { TextTelly } from "@health/contracts/families";
import { Button, buttonVariants } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { MessageCircle } from "lucide-react";
import { useRef, useState } from "react";

import { ApiNotice } from "@/components/win95";
import { useApi } from "@/lib/api";

/** The contact card "Telly" with the line's number, for the phone's Contacts. */
export const tellyVCard = (number: string) =>
	[
		"BEGIN:VCARD",
		"VERSION:3.0",
		"N:;Telly;;;",
		"FN:Telly",
		`TEL;TYPE=CELL:${number}`,
		"END:VCARD",
		"",
	].join("\r\n");

/** `+14155951440` as `+1 (415) 595-1440`; other countries as stored. */
const shown = (number: string) =>
	number.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 ($1) $2-$3");

function TellyNumber({
	number,
	myPhone,
}: {
	number: string;
	myPhone: string | null;
}) {
	const [status, setStatus] = useState<string | null>(null);
	const action = cn(buttonVariants(), "h-11 w-full");
	return (
		<>
			<p>Telly's iMessage number:</p>
			<p className="win95-inset select-all bg-card p-2 text-center font-bold text-xl">
				{shown(number)}
			</p>
			<p>
				{myPhone === null
					? "Save your phone number in Settings first, so Telly knows it is you."
					: `Telly answers texts from your number ${shown(myPhone)}.`}
			</p>
			<a
				className={cn(action, "win95-primary")}
				data-slot="button"
				href={`sms:${number}?&body=${encodeURIComponent("Hi Telly")}`}
			>
				<MessageCircle aria-hidden /> Message Telly
			</a>
			<a
				className={action}
				data-slot="button"
				download="Telly.vcf"
				href={`data:text/vcard;charset=utf-8,${encodeURIComponent(tellyVCard(number))}`}
			>
				Add to Contacts
			</a>
			<Button
				type="button"
				className="h-11 w-full"
				onClick={() =>
					void navigator.clipboard.writeText(number).then(
						() => setStatus("Copied."),
						() => setStatus("Could not copy. Select the number and copy it."),
					)
				}
			>
				Copy number
			</Button>
			{status !== null && <p role="status">{status}</p>}
		</>
	);
}

/** The "Text Telly" button and its dialog. */
export function TextTellyButton({ className }: { className?: string }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const state = useApi(TextTelly, "/api/text-telly");
	return (
		<>
			<Button
				type="button"
				className={cn("h-11", className)}
				onClick={() => dialog.current?.showModal()}
			>
				<MessageCircle aria-hidden /> Text Telly
			</Button>
			<dialog
				ref={dialog}
				aria-labelledby="text-telly-title"
				className="win95-raised win95-window m-auto w-[min(22rem,calc(100vw-2rem))] border-0 p-1.5 text-foreground backdrop:bg-black/30"
			>
				<h2
					id="text-telly-title"
					className="win95-titlebar flex items-center gap-1.5 px-1.5 py-1 text-sm"
				>
					<MessageCircle aria-hidden className="size-4" /> Text Telly
				</h2>
				<div className="grid gap-2 p-3 text-sm">
					{state.kind !== "ready" ? (
						<ApiNotice state={state} what="Telly's number" />
					) : state.value.tellyNumber === null ? (
						<p>Texting Telly is not set up on this server.</p>
					) : (
						<TellyNumber
							number={state.value.tellyNumber}
							myPhone={state.value.myPhone}
						/>
					)}
					<form method="dialog">
						<Button type="submit" className="h-11 w-full" autoFocus>
							Close
						</Button>
					</form>
				</div>
			</dialog>
		</>
	);
}
