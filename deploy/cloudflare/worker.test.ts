import { expect, test } from "bun:test";

// @ts-expect-error worker.js is plain JavaScript without types.
import worker from "./worker.js";

// Static assets as Cloudflare serves them without a not-found fallback: a missing file is a 404.
const files: Record<string, [string, string]> = {
	"/": ["<!doctype html>", "text/html"],
	"/assets/index-new.js": ["export {}", "text/javascript"],
};
const env = {
	LANDING_HOST: "saintess.tech",
	ASSETS: {
		fetch: async (request: Request) => {
			const file = files[new URL(request.url).pathname];
			return file
				? new Response(file[0], { headers: { "Content-Type": file[1] } })
				: new Response("Not Found", { status: 404 });
		},
	},
};
const get = (path: string, accept: string) =>
	worker.fetch(
		new Request(`https://app.saintess.tech${path}`, {
			headers: { Accept: accept },
		}),
		env,
	) as Promise<Response>;

test("a missing chunk is a 404, even when the browser accepts html", async () => {
	for (const accept of ["*/*", "text/html,*/*"]) {
		const response = await get("/assets/index-old.js", accept);
		expect(response.status).toBe(404);
	}
});

test("a page navigation to a client route gets index.html", async () => {
	const response = await get("/family", "text/html,application/xhtml+xml");
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("text/html");
});

test("a non-navigation request to a missing route is a 404", async () => {
	expect((await get("/family", "application/json")).status).toBe(404);
});

test("an existing file is served as is", async () => {
	const response = await get("/assets/index-new.js", "*/*");
	expect(response.status).toBe(200);
	expect(await response.text()).toBe("export {}");
});
