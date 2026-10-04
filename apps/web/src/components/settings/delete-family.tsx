// Settings › Delete family (#281): deletes the selected family for good. Only a member with
// `family_access` gets the action. The dialog asks for the family's exact name; the server checks
// access and the name again.
import { CareAccess } from "@health/contracts/care-profile";
import { Button } from "@health/ui/components/button";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import { Window } from "@/components/hud/window";
import { ApiNotice } from "@/components/win95";
import { type ApiFailure, apiRequest, familyPath, useApi } from "@/lib/api";
import { useFamily } from "@/lib/family";

export function DeleteFamilySettings() {
	const { family, reload } = useFamily();
	const access = useApi(
		CareAccess,
		family === null ? null : familyPath(family.id, "/care-access"),
	);
	const [open, setOpen] = useState(false);
	return (
		<Window
			icon={Trash2}
			title="Settings · Delete family"
			status="Deleting cannot be undone."
		>
			<div className="grid gap-3 p-2 text-sm">
				{family === null ? (
					<p>No person is paired yet.</p>
				) : access.kind !== "ready" ? (
					<ApiNotice state={access} what="your access to this family" />
				) : !access.value.mine.includes("family_access") ? (
					<p>
						Only a member with family access can delete <b>{family.name}</b>.
					</p>
				) : (
					<>
						<p>
							Delete <b>{family.name}</b> and everything in it for every member:
							health readings, messages, reminders, reports, saved PDFs, and the
							care plan.
						</p>
						<Button
							type="button"
							className="h-11 justify-self-start px-4"
							onClick={() => setOpen(true)}
						>
							Delete family…
						</Button>
					</>
				)}
			</div>
			{open && family !== null && (
				<ConfirmDialog
					familyId={family.id}
					name={family.name}
					onClose={() => setOpen(false)}
					onDeleted={() => {
						setOpen(false);
						reload();
					}}
				/>
			)}
		</Window>
	);
}

function ConfirmDialog({
	familyId,
	name,
	onClose,
	onDeleted,
}: {
	familyId: string;
	name: string;
	onClose: () => void;
	onDeleted: () => void;
}) {
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<ApiFailure | null>(null);
	const remove = async () => {
		const result = await apiRequest(null, familyPath(familyId), {
			method: "DELETE",
			body: { name: typed },
		});
		setBusy(false);
		if (result.kind === "ready") onDeleted();
		else setFailure(result);
	};
	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-3">
			<form
				role="dialog"
				aria-modal="true"
				aria-labelledby="delete-family-title"
				onKeyDown={(event) => event.key === "Escape" && onClose()}
				onSubmit={(event) => {
					event.preventDefault();
					void remove();
				}}
				className="win95-raised w-full max-w-md"
			>
				<h3
					id="delete-family-title"
					className="win95-titlebar px-2 py-1 text-sm"
				>
					Delete {name}?
				</h3>
				<div className="grid gap-3 p-3 text-sm">
					<p>
						This deletes the family and all of its records for every member. It
						cannot be undone.
					</p>
					<label className="grid gap-1">
						<span>
							Type <b>{name}</b> to confirm
						</span>
						<input
							autoComplete="off"
							className="win95-inset h-11 bg-card px-2"
							onChange={(event) => setTyped(event.target.value)}
							value={typed}
						/>
					</label>
					{failure !== null && (
						<p role="alert">
							Not deleted:{" "}
							{failure.kind === "signed_out"
								? "Sign in again."
								: failure.message}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" className="h-11 px-4" onClick={onClose}>
							Cancel
						</Button>
						<Button
							type="submit"
							className="h-11 px-4"
							disabled={busy || typed !== name}
						>
							{busy ? "Deleting…" : "Delete family"}
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}
