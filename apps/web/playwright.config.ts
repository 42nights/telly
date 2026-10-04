// Headless browser smoke test (`bun run smoke`): builds the web app against a fake server origin and
// serves it with `vite preview` on a free 127.0.0.1 port that this run owns.
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/** Nothing listens here; the spec answers this origin with `page.route`. */
export const SERVER_URL = "http://127.0.0.1:9";
export const OIDC_ISSUER = "http://127.0.0.1:9/issuer";

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address !== null
					? resolve(address.port)
					: reject(new Error("No free port")),
			);
		});
	});

// Workers load this file again; the env var keeps one port for the whole run.
process.env.SMOKE_PORT ??= String(await freePort());
const port = Number(process.env.SMOKE_PORT);
const outDir = join(tmpdir(), `telly-web-smoke-${port}`);

export default defineConfig({
	testDir: "smoke",
	// Not `*.spec.ts`: `bun test` would run those too.
	testMatch: "*.smoke.ts",
	outputDir: join(outDir, "results"),
	reporter: "list",
	forbidOnly: !!process.env.CI,
	use: { baseURL: `http://127.0.0.1:${port}`, browserName: "chromium" },
	webServer: {
		command: `vite build --outDir ${outDir}/app --emptyOutDir && vite preview --outDir ${outDir}/app --host 127.0.0.1 --port ${port} --strictPort`,
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: false,
		timeout: 180_000,
		env: {
			VITE_SERVER_URL: SERVER_URL,
			VITE_OIDC_ISSUER: OIDC_ISSUER,
			VITE_OIDC_CLIENT_ID: "telly-smoke",
		},
	},
});
