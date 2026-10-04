import { expect, spyOn, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Static imports load before `setupDom` registers `document`.
const { renderHook } = await import("@testing-library/react");
const { demoSampleSummary, useDemoWarning } = await import("./demo");

const real = { synthetic: false, metric: "steps" };

test("summarizes only samples that are not real, with sorted unique metrics", () => {
	expect(demoSampleSummary([])).toBeNull();
	expect(demoSampleSummary([real])).toBeNull();
	expect(
		demoSampleSummary([
			real,
			{ synthetic: true, metric: "sleep" },
			{ synthetic: true, metric: "heart_rate" },
			{ synthetic: true, metric: "sleep" },
		]),
	).toBe("3 demo samples that are not real readings (heart_rate, sleep)");
});

test("useDemoWarning logs once per different summary, and never for real data", () => {
	const consoleError = spyOn(console, "error").mockImplementation(() => {});
	try {
		const { rerender } = renderHook<
			void,
			{ samples: readonly (typeof real)[] | null }
		>(({ samples }) => useDemoWarning(samples, "Dashboard:"), {
			initialProps: { samples: null },
		});
		rerender({ samples: [real] });
		expect(consoleError).not.toHaveBeenCalled();

		const one = [{ synthetic: true, metric: "sleep" }];
		rerender({ samples: one });
		rerender({ samples: [...one] });
		expect(consoleError.mock.calls).toEqual([
			["Dashboard: 1 demo samples that are not real readings (sleep)."],
		]);

		rerender({ samples: [...one, { synthetic: true, metric: "steps" }] });
		expect(consoleError).toHaveBeenCalledTimes(2);
		expect(consoleError.mock.calls[1]).toEqual([
			"Dashboard: 2 demo samples that are not real readings (sleep, steps).",
		]);
	} finally {
		consoleError.mockRestore();
	}
});
