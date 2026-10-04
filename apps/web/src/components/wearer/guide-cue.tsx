// The guide on the camera (#348, #378): one guide state gives the arrow, the words drawn under it,
// and the words the voice says. The voice speaks only words that are drawn, once they stay for
// SPEAK_AFTER_MS, and stops older speech first, so it never says a direction the screen does not
// show.
import { ArrowUp } from "lucide-react";
import { useEffect } from "react";

/** One instruction: an arrow (screen angle in radians, 0 points right) and its words. */
export type Guide = { readonly angle: number; readonly words: string };

/** A direction must stay this long before the voice says it, so a passing one is not said. */
export const SPEAK_AFTER_MS = 800;

/** Says `text` with the browser's voice once it stays for SPEAK_AFTER_MS; a change stops it. */
function useGuideVoice(text: string | null, on: boolean) {
	useEffect(() => {
		const voice = globalThis.speechSynthesis;
		if (!on || text === null || voice === undefined) return;
		const timer = setTimeout(() => {
			voice.cancel();
			voice.speak(new SpeechSynthesisUtterance(text));
		}, SPEAK_AFTER_MS);
		return () => {
			clearTimeout(timer);
			// What was said is out of date now: the drawn guide changed or went.
			voice.cancel();
		};
	}, [text, on]);
}

const turn = (guide: Guide) => ({
	transform: `rotate(${guide.angle + Math.PI / 2}rad)`,
});

/**
 * The drawn guide and its voice. `big` adds the large arrow in the middle (the object is off
 * screen). Nothing is drawn or said without a guide.
 */
export function GuideCue({
	guide,
	big,
	voice,
}: {
	guide: Guide | null;
	big: boolean;
	voice: boolean;
}) {
	useGuideVoice(guide?.words ?? null, voice);
	if (guide === null) return null;
	return (
		<>
			{big && (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-0 grid place-items-center"
				>
					<ArrowUp
						className="size-24 text-[#ffd400] drop-shadow-[0_0_3px_#000] md:size-44"
						strokeWidth={3}
						style={turn(guide)}
					/>
				</div>
			)}
			<div className="pointer-events-none absolute inset-x-0 top-16 flex justify-center px-2">
				<p className="flex items-center gap-2 border-2 border-[#ffd400] bg-black/85 px-3 py-1 font-bold text-[#ffd400] text-[22px] md:gap-3 md:px-4 md:py-2 md:text-[32px]">
					<ArrowUp
						aria-hidden
						className="size-10 shrink-0"
						strokeWidth={3}
						style={turn(guide)}
					/>
					{guide.words}
				</p>
			</div>
		</>
	);
}
