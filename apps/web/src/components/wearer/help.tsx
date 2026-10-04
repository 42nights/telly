// The wearer's way to a person: Call family and the help panel. Calls open the phone's own dialer
// through `tel:` links; the app never calls anyone by itself.
import { Button, buttonVariants } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { Phone, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { SaveAndCall, useSaveAndCall } from "@/components/hud/save-and-call";
import { telHref, useContacts } from "@/lib/contacts";

import { Asked, xl } from "./answer";

const big = "h-14 w-full text-[20px] [&_svg]:size-6";

/**
 * Call family: the number saved on this phone. Without one, a tap asks for it in place: Save &
 * Call keeps it here and in the care profile contacts (#360, #379). The profile is read only then.
 */
function CallFamily({ familyId }: { familyId: string | null }) {
	const [asking, setAsking] = useState(false);
	const { contacts, note, call } = useSaveAndCall(
		asking ? familyId : null,
		"familyPhone",
		"Family",
	);
	const number = contacts.familyPhone;
	if (number !== null)
		return (
			<div className="grid gap-1">
				<a
					className={cn(buttonVariants({ variant: "outline" }), big)}
					data-slot="button"
					href={telHref(number)}
				>
					<Phone aria-hidden /> Call family
				</a>
				{note !== null && <p className="text-[16px]">{note}</p>}
			</div>
		);
	if (asking)
		return <SaveAndCall big label="Family phone number" onCall={call} />;
	return (
		<Button className={big} onClick={() => setAsking(true)} variant="outline">
			<Phone aria-hidden /> Call family
		</Button>
	);
}

/** Under every answer: a person to talk to, and the help panel. Calm talk never hides them. */
export function SupportActions({
	familyId,
	onHelp,
}: {
	familyId: string | null;
	onHelp: () => void;
}) {
	return (
		<div className="grid gap-2 sm:grid-cols-2">
			<CallFamily familyId={familyId} />
			<Button
				className={cn(big, "font-bold text-destructive!")}
				onClick={onHelp}
				variant="outline"
			>
				<TriangleAlert aria-hidden /> I need help now
			</Button>
		</div>
	);
}

/**
 * The help flow for an urgent request: the emergency number first, then family. It opens before
 * any model answers, and it never says that anyone was called.
 */
export function HelpPanel({
	familyId,
	asked,
	onDone,
}: {
	familyId: string | null;
	asked: string | null;
	onDone: () => void;
}) {
	const [{ emergency }] = useContacts();
	return (
		<div className="grid gap-3">
			{asked !== null && <Asked asked={asked} />}
			<div
				className="win95-raised grid grid-cols-[auto_1fr] gap-3 p-4"
				role="alert"
			>
				<TriangleAlert aria-hidden className="size-8 text-destructive" />
				<div className="grid gap-1">
					<p className="font-semibold text-[24px]">This sounds urgent.</p>
					<p className="text-[20px]">Call for help now.</p>
				</div>
			</div>
			<a
				className={cn(buttonVariants(), xl, "win95-primary font-bold")}
				data-slot="button"
				href={telHref(emergency)}
			>
				<Phone aria-hidden /> Call {emergency}
			</a>
			<CallFamily familyId={familyId} />
			<p className="text-[16px]">
				Calls open your phone's dialer. This app does not call anyone by itself.
			</p>
			<Button className={big} onClick={onDone} variant="outline">
				Not urgent? Go back
			</Button>
		</div>
	);
}
