import { useEffect } from "react";

type Sample = { readonly synthetic: boolean; readonly metric: string };

/** The count and metrics (no values) of samples that are not real, or null when all are real. */
export const demoSampleSummary = (
	samples: readonly Sample[],
): string | null => {
	const demo = samples.filter((s) => s.synthetic);
	if (demo.length === 0) return null;
	const metrics = [...new Set(demo.map((s) => s.metric))].sort().join(", ");
	return `${demo.length} demo samples that are not real readings (${metrics})`;
};

/** Fails loudly in the console, once per different summary, when `samples` hold data that is not real. */
export const useDemoWarning = (
	samples: readonly Sample[] | null,
	where: string,
) => {
	const demo = samples === null ? null : demoSampleSummary(samples);
	useEffect(() => {
		if (demo !== null) console.error(`${where} ${demo}.`);
	}, [demo, where]);
};
