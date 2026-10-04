// The medicine finder opened from an iMessage link (#308), without sign-in. The link token works
// once: the page trades it for a page session and keeps that session only in memory. A reload sends
// the used token again, and a used or expired link goes to the normal sign-in.
import {
	FinderPhotoSaved,
	LinkedFinder as LinkedFinderReply,
	type FinderPhotoSaved as Saved,
} from "@health/contracts/finder-link";
import { Button } from "@health/ui/components/button";
import { cn } from "@health/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { Camera, MapPinOff, RotateCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Window } from "@/components/hud/window";
import { ENV } from "@/env";
import { failureFor } from "@/lib/api";

import { ago } from "./logic";
import { useNow } from "./use-now";

type Reply<A> =
	| { readonly kind: "ready"; readonly value: A }
	/** 401: the link or the page session is used or expired. */
	| { readonly kind: "expired" }
	| { readonly kind: "error"; readonly message: string };

/** POSTs to a finder-link route. These routes take no sign-in, so this is not `apiRequest`. */
const post = async <A,>(
	schema: Schema.Decoder<A>,
	route: "open" | "photo",
	body: unknown,
): Promise<Reply<A>> => {
	let response: Response;
	try {
		response = await fetch(`${ENV.VITE_SERVER_URL}/api/finder-link/${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		return { kind: "error", message: `The server is not reachable: ${error}` };
	}
	if (!response.ok) {
		const failure = failureFor(
			response.status,
			await response.json().catch(() => undefined),
		);
		return failure.kind === "signed_out"
			? { kind: "expired" }
			: { kind: "error", message: failure.message };
	}
	try {
		return {
			kind: "ready",
			value: await Schema.decodeUnknownPromise(schema)(await response.json()),
		};
	} catch (error) {
		return {
			kind: "error",
			message: `The server sent an unexpected reply: ${error}`,
		};
	}
};

// One `open` per token: React runs a new effect twice in development, and a link works once.
const opened = new Map<string, Promise<Reply<LinkedFinderReply>>>();

const MAX_SIDE = 1600;

/** The photo as base64 JPEG, at most `MAX_SIDE` px on its long side. */
const photoData = async (file: File): Promise<string> => {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	const url = canvas.toDataURL("image/jpeg", 0.85);
	return url.slice(url.indexOf(",") + 1);
};

const big = "h-16 w-full text-[22px] [&_svg]:size-7";
const box = "win95-raised grid gap-3 p-3";

type Photo =
	| { readonly kind: "idle" }
	| { readonly kind: "saving" }
	| { readonly kind: "saved"; readonly saved: Saved["saved"] }
	| { readonly kind: "error"; readonly message: string };

function AddPlace({
	session,
	highlight,
	onSaved,
	onExpired,
}: {
	session: string;
	highlight: boolean;
	onSaved: (saved: Saved) => void;
	onExpired: () => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [photo, setPhoto] = useState<Photo>({ kind: "idle" });
	const send = async (file: File) => {
		setPhoto({ kind: "saving" });
		let data: string;
		try {
			data = await photoData(file);
		} catch {
			setPhoto({
				kind: "error",
				message: "I can't read this photo. Take a new photo.",
			});
			return;
		}
		const reply = await post(FinderPhotoSaved, "photo", {
			session,
			image: { type: "image/jpeg", data },
		});
		if (reply.kind === "expired") return onExpired();
		if (reply.kind === "error") return setPhoto(reply);
		setPhoto({ kind: "saved", saved: reply.value.saved });
		onSaved(reply.value);
	};
	return (
		<section
			aria-label="Add a place"
			className={cn(box, highlight && "outline-4 outline-primary")}
		>
			<h3 className="font-semibold text-[24px]">Add a place</h3>
			<p>
				Take a photo of one thing where it is now. I save what it is and where.
			</p>
			<Button
				className={cn(big, "win95-primary")}
				disabled={photo.kind === "saving"}
				onClick={() => input.current?.click()}
			>
				<Camera aria-hidden />
				Take a photo
			</Button>
			<input
				accept="image/*"
				aria-label="Photo of one thing where it is now"
				capture="environment"
				className="hidden"
				onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					event.currentTarget.value = "";
					if (file !== undefined) void send(file);
				}}
				ref={input}
				type="file"
			/>
			{photo.kind === "saving" && <p role="status">Saving the photo…</p>}
			{photo.kind === "saved" && (
				<p className="font-semibold" role="status">
					Saved: {photo.saved.container}, {photo.saved.place}.
				</p>
			)}
			{photo.kind === "error" && (
				<p className="text-destructive" role="alert">
					{photo.message}
				</p>
			)}
		</section>
	);
}

function Places({ finder }: { finder: LinkedFinderReply }) {
	const now = useNow();
	return (
		<section aria-label="Your places" className={box}>
			<h3 className="font-semibold text-[24px]">Where things were last seen</h3>
			{finder.sightings.length === 0 ? (
				<p>Nothing is saved yet.</p>
			) : (
				<>
					<ul className="grid gap-2">
						{finder.sightings.map((sighting) => (
							<li
								className="win95-inset grid gap-1 bg-card p-3"
								key={sighting.id}
							>
								<b className="break-words">{sighting.container}</b>
								<span className="break-words">{sighting.place}</span>
								<span className="text-[18px] text-muted-foreground">
									Seen {ago(now - Date.parse(sighting.seenAt))}
								</span>
								{sighting.notFoundAt !== null && (
									<span className="flex items-center gap-2 font-semibold">
										<MapPinOff aria-hidden className="size-5 shrink-0" />
										Not there when last checked
									</span>
								)}
							</li>
						))}
					</ul>
					<p className="text-[18px]">
						These are past places. The thing can be in a different place now.
					</p>
				</>
			)}
		</section>
	);
}

function OpenFailed({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div className="grid gap-3" role="alert">
			<p className="break-words">{message}</p>
			<Button className={big} onClick={onRetry} variant="outline">
				<RotateCw aria-hidden />
				Try again
			</Button>
		</div>
	);
}

/** The finder page for a link token. `person` and `q` come from the link. */
export function LinkedFinder({
	token,
	person,
	q,
	add,
}: {
	token: string;
	person: string | undefined;
	q: string;
	add: boolean;
}) {
	const navigate = useNavigate();
	const [state, setState] = useState<Reply<LinkedFinderReply> | null>(null);
	const [attempt, setAttempt] = useState(0);
	const expired = useCallback(
		() =>
			void navigate({
				to: "/sign-in",
				search: {
					redirect:
						person === undefined
							? "/medicine"
							: `/medicine?person=${encodeURIComponent(person)}`,
				},
				replace: true,
			}),
		[navigate, person],
	);

	useEffect(() => {
		void attempt;
		let live = true;
		let reply = opened.get(token);
		if (reply === undefined) {
			reply = post(LinkedFinderReply, "open", { token });
			opened.set(token, reply);
		}
		void reply.then((result) => {
			if (!live) return;
			if (result.kind === "expired") return expired();
			setState(result);
		});
		return () => {
			live = false;
		};
	}, [token, attempt, expired]);

	const finder = state?.kind === "ready" ? state.value : null;
	const retry = () => {
		opened.delete(token);
		setState(null);
		setAttempt((n) => n + 1);
	};

	const addPlace = finder?.remembering === true && (
		<AddPlace
			highlight={add}
			onExpired={expired}
			onSaved={(saved) => setState({ kind: "ready", value: saved.finder })}
			session={finder.session}
		/>
	);

	return (
		<main className="mx-auto grid w-full max-w-3xl gap-2 p-2 md:p-4">
			<Window icon={Search} title="Find your things">
				<div className="grid gap-4 p-2 text-[20px] md:p-5">
					{q.trim() !== "" && (
						<p>
							You asked about <b className="break-words">“{q}”</b>.
						</p>
					)}
					{state === null && <p role="status">Opening your places…</p>}
					{state?.kind === "error" && (
						<OpenFailed message={state.message} onRetry={retry} />
					)}
					{finder !== null && !finder.remembering && (
						<p className={box}>
							Remembering places is off. Your family can turn it on in Settings
							&gt; Medicine places.
						</p>
					)}
					{add && addPlace}
					{finder !== null && <Places finder={finder} />}
					{!add && addPlace}
					{finder !== null && (
						<p>
							This page works until{" "}
							{new Date(finder.expiresAt).toLocaleTimeString([], {
								hour: "numeric",
								minute: "2-digit",
							})}
							.
						</p>
					)}
				</div>
			</Window>
		</main>
	);
}
