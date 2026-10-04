// One-use links to a lab report PDF (#364), mounted at `/api/report-pdf-links` before the sign-in
// check: the link itself is the credential. The iOS app's WebView cannot show or save a `blob:`
// PDF, so the web app asks for a link (the report route checks the caller's membership and health
// records scope) and opens it in the system viewer. The link holds the PDF made at that moment,
// answers once, and expires after five minutes.
import { Hono } from "hono";
import { ApiFailure } from "./http";

export const PDF_LINK_SECONDS = 300;

type PdfLink = {
	readonly pdf: Uint8Array<ArrayBuffer>;
	readonly filename: string;
	readonly expires: number;
};

// ponytail: in-process map, fine for the one API container; move to shared storage if it scales out.
const links = new Map<string, PdfLink>();

/** Keeps `pdf` behind a new one-use link and returns the link's path and expiry time. */
export const issuePdfLink = (
	pdf: Uint8Array<ArrayBuffer>,
	filename: string,
) => {
	const now = Date.now();
	for (const [token, link] of links)
		if (link.expires <= now) links.delete(token);
	const token = crypto.randomUUID();
	const expires = now + PDF_LINK_SECONDS * 1000;
	links.set(token, { pdf, filename, expires });
	return {
		url: `/api/report-pdf-links/${token}`,
		expiresAt: new Date(expires).toISOString(),
	};
};

export const reportPdfLinkRoutes = () =>
	new Hono().get("/:token", (c) => {
		const token = c.req.param("token");
		const link = links.get(token);
		links.delete(token);
		if (link === undefined || link.expires <= Date.now())
			throw new ApiFailure("not_found", "This PDF link was used or expired");
		const disposition =
			c.req.query("download") === undefined ? "inline" : "attachment";
		return c.body(link.pdf, 200, {
			"Content-Type": "application/pdf",
			"Content-Disposition": `${disposition}; filename="${link.filename}"`,
			"Cache-Control": "private, no-store",
		});
	});
