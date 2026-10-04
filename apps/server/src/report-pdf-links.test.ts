import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createApp } from "./app";
import { issuePdfLink, PDF_LINK_SECONDS } from "./report-pdf-links";

// Sign-in is configured off, so only routes outside `/api/*` sign-in can answer without a session.
const app = createApp({
	corsOrigin: "http://localhost:3001",
	auth: undefined,
	voice: {
		apiKey: undefined,
		voiceId: "unused",
		baseUrl: "http://127.0.0.1:1",
	},
});
const pdf = new TextEncoder().encode("%PDF-1.4 synthetic");

afterEach(() => setSystemTime());

describe("one-use PDF links", () => {
	test("a link answers its PDF once, without sign-in", async () => {
		const { url } = issuePdfLink(pdf, "Telly lab report 2026-10-04.pdf");
		const first = await app.request(url);
		expect(first.status).toBe(200);
		expect(first.headers.get("content-type")).toBe("application/pdf");
		expect(first.headers.get("content-disposition")).toBe(
			'inline; filename="Telly lab report 2026-10-04.pdf"',
		);
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(pdf);
		expect((await app.request(url)).status).toBe(404);
	});

	test("a download link asks the viewer to save the file", async () => {
		const { url } = issuePdfLink(pdf, "a.pdf");
		const saved = await app.request(`${url}?download`);
		expect(saved.headers.get("content-disposition")).toBe(
			'attachment; filename="a.pdf"',
		);
	});

	test("a link expires after five minutes, and a made-up token finds nothing", async () => {
		const start = new Date("2026-10-04T12:00:00Z");
		setSystemTime(start);
		const { url, expiresAt } = issuePdfLink(pdf, "a.pdf");
		expect(expiresAt).toBe("2026-10-04T12:05:00.000Z");
		setSystemTime(new Date(start.getTime() + PDF_LINK_SECONDS * 1000));
		expect((await app.request(url)).status).toBe(404);
		expect(
			(await app.request(`/api/report-pdf-links/${crypto.randomUUID()}`))
				.status,
		).toBe(404);
	});
});
