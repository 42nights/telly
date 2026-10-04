import {
	CookingSuggestions,
	type MealSuggestion,
} from "@health/contracts/cooking";
import { Button } from "@health/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { ChefHat, Loader2 } from "lucide-react";
import { useState } from "react";

import { CookingSession } from "@/components/cooking/session";
import { Window } from "@/components/hud/window";
import { ApiNotice } from "@/components/win95";
import { type ApiResult, apiRequest, familyPath } from "@/lib/api";
import { useFamily } from "@/lib/family";

export const Route = createFileRoute("/cooking")({
	component: CookingComponent,
});

const field =
	"win95-inset win95-field min-w-0 bg-white px-3 py-2 text-[18px] text-black";
const big = "h-14 text-[18px] [&_svg]:size-5";

/** "eggs, bread\nmilk" → ["eggs", "bread", "milk"]. */
const items = (text: string) =>
	text
		.split(/[,\n]/)
		.map((s) => s.trim().slice(0, 80))
		.filter((s) => s !== "")
		.slice(0, 40);

function Suggestions({
	result,
	onStart,
}: {
	result: CookingSuggestions;
	onStart: (meal: MealSuggestion) => void;
}) {
	return (
		<div className="grid gap-4" aria-live="polite">
			{result.notices.length > 0 && (
				<section aria-labelledby="cook-notices" className="grid gap-1">
					<h2 className="font-bold text-[18px]" id="cook-notices">
						Before you choose
					</h2>
					<ul className="win95-inset grid list-disc gap-1 bg-card py-2 pr-3 pl-8 text-[18px]">
						{result.notices.map((notice) => (
							<li key={notice}>{notice}</li>
						))}
					</ul>
				</section>
			)}
			{result.instructions.length > 0 && (
				<section aria-labelledby="cook-instructions" className="grid gap-1">
					<h2 className="font-bold text-[18px]" id="cook-instructions">
						Your care instructions about food
					</h2>
					<ul className="grid gap-1 text-[18px]">
						{result.instructions.map((i) => (
							<li
								className="win95-inset bg-white p-2 text-black"
								key={i.instruction}
							>
								<b>{i.name}:</b> “{i.instruction}”
								{!i.verified && " (not verified, ask your caregiver)"}
							</li>
						))}
					</ul>
				</section>
			)}
			{result.suggestions.length === 0 ? (
				<p className="text-[18px]" role="status">
					No meal here fits your needs. Ask your caregiver or a family member to
					help you choose.
				</p>
			) : (
				<ul className="grid gap-3">
					{result.suggestions.map((meal) => {
						const need = meal.ingredients.filter((i) => !i.have && !i.optional);
						const helpers = meal.steps.filter((s) => s.helper).length;
						return (
							<li className="win95-inset grid gap-2 bg-card p-3" key={meal.id}>
								<h3 className="font-bold text-[20px]">{meal.name}</h3>
								<p className="text-[16px]">
									{need.length === 0
										? "You have everything you need."
										: `You also need: ${need.map((i) => i.name).join(", ")}.`}
									{helpers > 0 &&
										` ${helpers} of ${meal.steps.length} steps need a helper with you.`}
								</p>
								<Button
									className={`win95-primary ${big}`}
									onClick={() => onStart(meal)}
								>
									Start
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

/**
 * Choose a meal from the food at home, then make it one step at a time. Meals are filtered by the
 * care profile and the agreed kitchen abilities on the server; every unknown is shown first.
 */
function CookingComponent() {
	const { state, family } = useFamily();
	const familyId = family?.id ?? null;
	const [have, setHave] = useState("");
	const [avoid, setAvoid] = useState("");
	const [result, setResult] = useState<
		ApiResult<CookingSuggestions> | "loading" | null
	>(null);
	const [meal, setMeal] = useState<MealSuggestion | null>(null);

	const find = async () => {
		// Without a family, say why: none paired, the list still loading, or the list's own failure.
		if (familyId === null)
			return setResult(
				state.kind === "ready"
					? { kind: "error", message: "No person is paired yet." }
					: state.kind === "loading"
						? {
								kind: "error",
								message: "Your family is still loading. Try again in a moment.",
							}
						: state,
			);
		setResult("loading");
		setResult(
			await apiRequest(
				CookingSuggestions,
				familyPath(familyId, "/cooking/suggestions"),
				{
					method: "POST",
					body: { available: items(have), avoid: items(avoid).slice(0, 20) },
				},
			),
		);
	};

	return (
		<main className="mx-auto w-full max-w-3xl p-2 md:p-4">
			<Window icon={ChefHat} title="Cook">
				<div className="grid gap-4 p-2 md:p-5">
					{meal !== null ? (
						<CookingSession
							familyId={familyId}
							meal={meal}
							onDone={() => setMeal(null)}
						/>
					) : (
						<>
							<form
								className="grid gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									void find();
								}}
							>
								<label className="text-[18px]" htmlFor="cook-have">
									What food do you have?
								</label>
								<textarea
									className={`${field} h-20`}
									id="cook-have"
									onChange={(event) => setHave(event.target.value)}
									placeholder="Eggs, bread, milk"
									value={have}
								/>
								<label className="text-[18px]" htmlFor="cook-avoid">
									Anything you don't want today? (optional)
								</label>
								<input
									className={`${field} h-12`}
									id="cook-avoid"
									onChange={(event) => setAvoid(event.target.value)}
									placeholder="Cheese"
									value={avoid}
								/>
								<Button
									className={`win95-primary ${big}`}
									disabled={result === "loading"}
									type="submit"
								>
									{result === "loading" && (
										<Loader2 aria-hidden className="animate-spin" />
									)}
									Find meals
								</Button>
							</form>
							{result !== null &&
								result !== "loading" &&
								(result.kind === "ready" ? (
									<Suggestions onStart={setMeal} result={result.value} />
								) : (
									<ApiNotice state={result} what="meal ideas" />
								))}
						</>
					)}
				</div>
			</Window>
		</main>
	);
}
