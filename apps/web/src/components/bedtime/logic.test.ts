import { describe, expect, test } from "bun:test";

import { chargeLine, connectionLine, timerLeft } from "./logic";

describe("overnight readiness", () => {
	test("an unknown battery is not ready and is not shown as a zero charge", () => {
		expect(chargeLine(null)).toMatchObject({ ok: false });
		expect(chargeLine(null).text).toContain("unknown");
		expect(chargeLine({ level: 0, charging: true })).toEqual({
			ok: true,
			text: "Charging · 0 %",
		});
		expect(chargeLine({ level: 0.9, charging: false }).ok).toBe(false);
	});

	test("the network being up does not mean the server answers", () => {
		expect(connectionLine(false, true).ok).toBe(false);
		expect(connectionLine(true, false)).toEqual({
			ok: false,
			text: "Network on, but the server does not answer.",
		});
		expect(connectionLine(true, true).ok).toBe(true);
	});

	test("the sleep timer counts down to zero and never below", () => {
		expect(timerLeft(null, 0)).toBeNull();
		expect(timerLeft(30 * 60_000, 0)).toBe("30:00");
		expect(timerLeft(65_500, 0)).toBe("1:06");
		expect(timerLeft(1_000, 5_000)).toBe("0:00");
	});
});
