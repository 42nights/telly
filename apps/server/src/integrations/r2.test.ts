import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { r2Bucket } from "./r2";

// Test-only stand-in for R2's S3 API: it records each request and answers with the queued handler.
type Seen = {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: Headers;
	body: Uint8Array;
};
let seen: Seen[] = [];
let reply: (request: Request) => Response = () => new Response(null);
const s3 = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request) => {
		const url = new URL(request.url);
		seen.push({
			method: request.method,
			path: url.pathname,
			query: url.searchParams,
			headers: request.headers,
			body: new Uint8Array(await request.arrayBuffer()),
		});
		return reply(request);
	},
});
afterAll(() => s3.stop(true));
beforeEach(() => {
	seen = [];
});

const config = {
	endpoint: s3.url.href, // ends with "/": the bucket must not get a double slash
	bucket: "reports",
	accessKeyId: "AKTEST",
	secretAccessKey: "secret",
};
const bucket = r2Bucket(config);

const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: { name: string; code: string; message: string }) => [
			error.name,
			error.code,
			error.message,
		],
	);

describe("put", () => {
	test("sends a signed PUT of the body with its type to the bucket key", async () => {
		reply = () => new Response(null);
		await bucket.put(
			"7/report.pdf",
			new Uint8Array([37, 80, 68, 70]),
			"application/pdf",
		);
		expect(seen).toHaveLength(1);
		const [request] = seen;
		expect(request?.method).toBe("PUT");
		expect(request?.path).toBe("/reports/7/report.pdf");
		expect(request?.headers.get("content-type")).toBe("application/pdf");
		expect([...(request?.body ?? [])]).toEqual([37, 80, 68, 70]);
		expect(request?.headers.get("authorization")).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKTEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*, Signature=[0-9a-f]{64}$/,
		);
	});

	test("a refusal is upstream_error; a server error is unavailable after retries", async () => {
		reply = () => new Response("denied", { status: 403 });
		expect(await failure(bucket.put("k", new Uint8Array(), "x"))).toEqual([
			"ApiFailure",
			"upstream_error",
			"PDF storage could not save the PDF: HTTP 403",
		]);
		expect(seen).toHaveLength(1);

		seen = [];
		reply = () => new Response("busy", { status: 503 });
		expect(await failure(bucket.put("k", new Uint8Array(), "x"))).toEqual([
			"ApiFailure",
			"unavailable",
			"PDF storage could not save the PDF: HTTP 503",
		]);
		expect(seen).toHaveLength(3);
	});

	test("a rate limit is unavailable", async () => {
		reply = () => new Response(null, { status: 429 });
		expect((await failure(bucket.put("k", new Uint8Array(), "x")))?.[1]).toBe(
			"unavailable",
		);
	});

	test("a retried server error that then succeeds is a save", async () => {
		let calls = 0;
		reply = () => new Response(null, { status: ++calls === 1 ? 500 : 200 });
		await bucket.put("k", new Uint8Array([1]), "x");
		expect(seen).toHaveLength(2);
	});
});

describe("exists", () => {
	test("200 is true and 404 is false, both through a signed HEAD", async () => {
		reply = () => new Response(null);
		expect(await bucket.exists("7/a.pdf")).toBe(true);
		reply = () => new Response(null, { status: 404 });
		expect(await bucket.exists("7/b.pdf")).toBe(false);
		expect(seen.map((request) => [request.method, request.path])).toEqual([
			["HEAD", "/reports/7/a.pdf"],
			["HEAD", "/reports/7/b.pdf"],
		]);
		expect(seen[0]?.headers.get("authorization")).toStartWith(
			"AWS4-HMAC-SHA256",
		);
	});

	test("another status is a read failure", async () => {
		reply = () => new Response(null, { status: 401 });
		expect(await failure(bucket.exists("k"))).toEqual([
			"ApiFailure",
			"upstream_error",
			"PDF storage could not read the PDF: HTTP 401",
		]);
	});

	test("an unreachable endpoint is unavailable", async () => {
		const endpoint = "http://127.0.0.1:1"; // nothing listens on port 1
		expect(
			await failure(r2Bucket({ ...config, endpoint }).exists("k")),
		).toEqual(["ApiFailure", "unavailable", "PDF storage is not reachable"]);
	});
});

describe("presign", () => {
	test("is a query-signed GET link with expiry and a download filename", async () => {
		const link = new URL(
			await bucket.presign("7/r.pdf", "Lab report.pdf", 300),
		);
		expect(link.origin).toBe(s3.url.origin);
		expect(link.pathname).toBe("/reports/7/r.pdf");
		expect(link.searchParams.get("X-Amz-Expires")).toBe("300");
		expect(link.searchParams.get("response-content-disposition")).toBe(
			'attachment; filename="Lab report.pdf"',
		);
		expect(link.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
		expect(link.searchParams.get("X-Amz-Credential")).toMatch(
			/^AKTEST\/\d{8}\/auto\/s3\/aws4_request$/,
		);
		expect(link.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
		// The signature depends on the secret, so a link signed with another secret differs.
		const other = new URL(
			await r2Bucket({ ...config, secretAccessKey: "other" }).presign(
				"7/r.pdf",
				"Lab report.pdf",
				300,
			),
		);
		expect(other.searchParams.get("X-Amz-Signature")).not.toBe(
			link.searchParams.get("X-Amz-Signature"),
		);
		expect(seen).toHaveLength(0); // signing sends nothing
	});
});

const listing = (entries: string[], next?: string) =>
	`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${entries.join("")}<IsTruncated>${next !== undefined}</IsTruncated>${next === undefined ? "" : `<NextContinuationToken>${next}</NextContinuationToken>`}</ListBucketResult>`;
const entry = (key: string, size: number, at: string) =>
	`<Contents>\n<Key>${key}</Key><LastModified>${at}</LastModified><Size>${size}</Size></Contents>`;

describe("list", () => {
	test("follows continuation tokens and returns every object under the prefix", async () => {
		reply = (request) =>
			new URL(request.url).searchParams.get("continuation-token") === "page2"
				? new Response(
						listing([entry("7/c.pdf", 3, "2026-01-03T00:00:00.000Z")]),
					)
				: new Response(
						listing(
							[
								entry("7/a.pdf", 10, "2026-01-01T00:00:00.000Z"),
								entry("7/b.pdf", 20, "2026-01-02T00:00:00.000Z"),
							],
							"page2",
						),
					);
		expect(await bucket.list("7/")).toEqual([
			{ key: "7/a.pdf", size: 10, lastModified: "2026-01-01T00:00:00.000Z" },
			{ key: "7/b.pdf", size: 20, lastModified: "2026-01-02T00:00:00.000Z" },
			{ key: "7/c.pdf", size: 3, lastModified: "2026-01-03T00:00:00.000Z" },
		]);
		expect(
			seen.map((request) => [
				request.method,
				request.path,
				request.query.get("list-type"),
				request.query.get("prefix"),
				request.query.get("continuation-token"),
			]),
		).toEqual([
			["GET", "/reports", "2", "7/", null],
			["GET", "/reports", "2", "7/", "page2"],
		]);
	});

	test("an empty bucket is an empty list", async () => {
		reply = () => new Response(listing([]));
		expect(await bucket.list("9/")).toEqual([]);
		expect(seen).toHaveLength(1);
	});

	test("an error status is a list failure", async () => {
		reply = () => new Response("<Error/>", { status: 403 });
		expect(await failure(bucket.list("7/"))).toEqual([
			"ApiFailure",
			"upstream_error",
			"PDF storage could not list the PDFs: HTTP 403",
		]);
	});

	test("an entry without a key, date, or numeric size is an upstream error, not an outage", async () => {
		for (const bad of [
			"<Contents><Size>1</Size></Contents>",
			entry("7/a.pdf", Number.NaN, "2026-01-01T00:00:00.000Z"),
			"<Contents><Key>7/a.pdf</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>",
		]) {
			reply = () => new Response(listing([bad]));
			expect(await failure(bucket.list("7/"))).toEqual([
				"ApiFailure",
				"upstream_error",
				"PDF storage sent an unreadable listing",
			]);
		}
	});
});
