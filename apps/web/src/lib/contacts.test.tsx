import { afterEach, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: these modules read `document`, which `@/lib/test/dom` sets up first.
const { act, renderHook } = await import("@testing-library/react");
const { FAMILY_PHONE, isFullPhoneNumber, telHref, useContacts } = await import(
	"@/lib/contacts"
);

afterEach(() => setSystemTime());

test("a dialable number is a 3-digit emergency code or 7 to 15 digits with phone punctuation", () => {
	for (const ok of [
		"911",
		" 112 ",
		"555-0100",
		"+1 (555) 010-0199",
		"1.555.010.0199",
	])
		expect(isFullPhoneNumber(ok)).toBe(true);
	for (const bad of [
		"",
		"12",
		"5555",
		"1234567890123456",
		"call mom",
		"555-0100 x2",
		"+",
	])
		expect(isFullPhoneNumber(bad)).toBe(false);
});

test("a tel: link keeps only a leading plus and the digits", () => {
	expect(telHref(" +1 (555) 010-0199 ")).toBe("tel:+15550100199");
	expect(telHref("555.0100")).toBe("tel:5550100");
	expect(telHref("911")).toBe("tel:911");
});

test("with nothing saved, family calls go to the fixed number and the emergency number is 911", () => {
	const { result } = renderHook(() => useContacts());
	expect(result.current[0]).toEqual({
		momPhone: null,
		familyPhone: FAMILY_PHONE,
		emergency: "911",
		savedAt: null,
	});
});

test("saved data that is corrupt, not an object, or holds bad numbers falls back per field", () => {
	for (const corrupt of ["{oops", "42", "null"]) {
		localStorage.setItem("telly.contacts", corrupt);
		const { result, unmount } = renderHook(() => useContacts());
		expect(result.current[0]).toEqual({
			momPhone: null,
			familyPhone: FAMILY_PHONE,
			emergency: "911",
			savedAt: null,
		});
		unmount();
	}

	localStorage.setItem(
		"telly.contacts",
		JSON.stringify({
			momPhone: "555-0100",
			familyPhone: 5550100,
			emergency: "not a number",
			savedAt: "yesterday",
		}),
	);
	const { result } = renderHook(() => useContacts());
	expect(result.current[0]).toEqual({
		momPhone: "555-0100",
		familyPhone: FAMILY_PHONE,
		emergency: "911",
		savedAt: null,
	});
});

test("a save is stored with its time and updates every screen that shows the numbers", () => {
	setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
	const settings = renderHook(() => useContacts());
	const help = renderHook(() => useContacts());
	const [, save] = settings.result.current;

	act(() =>
		save({
			momPhone: "+1 555 010 0199",
			familyPhone: "555-0123",
			emergency: "112",
			savedAt: null,
		}),
	);

	const saved = {
		momPhone: "+1 555 010 0199",
		familyPhone: FAMILY_PHONE,
		emergency: "112",
		savedAt: Date.parse("2026-10-04T12:00:00.000Z"),
	};
	expect(settings.result.current[0]).toEqual(saved);
	expect(help.result.current[0]).toEqual(saved);

	// A screen opened later reads the same saved numbers.
	help.unmount();
	expect(renderHook(() => useContacts()).result.current[0]).toEqual(saved);
});
