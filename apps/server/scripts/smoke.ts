// Checks real HTTP responses against the contracts. Without an argument, it runs the built server
// under Node and checks that SIGTERM shuts it down (run `bun run build` first). With a URL, it checks
// that deployed server instead. Usage: bun run smoke [https://deployed.example]
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { Health, Sources } from "@health/contracts";
import { Schema } from "effect";

const deployed = process.argv[2]?.replace(/\/$/, "");
const port = 3900 + Math.floor(Math.random() * 100);
const base = deployed ?? `http://127.0.0.1:${port}`;
const server = deployed
	? undefined
	: spawn("node", ["dist/index.mjs"], {
			cwd: new URL("../", import.meta.url),
			env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
			stdio: "inherit",
		});

const get = async (path: string) => (await fetch(`${base}${path}`)).json();

try {
	let health: unknown;
	for (let attempt = 0; health === undefined; attempt++) {
		if (attempt === 50)
			throw new Error(`${base} did not answer /health within 10 s`);
		health = await get("/health").catch(() => undefined);
		if (health === undefined) await sleep(200);
	}
	Schema.decodeUnknownSync(Health)(health);
	const { sources } = Schema.decodeUnknownSync(Sources)(
		await get("/api/sources"),
		{
			onExcessProperty: "error",
		},
	);
	// Any valid state: the server derives it from stored WHOOP samples (#307), so it is live data.
	if (!sources.some((s) => s.source === "noop"))
		throw new Error("NOOP must be reported as a source");
} finally {
	server?.kill("SIGTERM");
}
if (server) {
	const timeout = setTimeout(() => {
		console.error("smoke: server did not exit within 5 s of SIGTERM");
		process.exit(1);
	}, 5000);
	await once(server, "exit");
	clearTimeout(timeout);
}
console.log(`smoke: ok (${base})`);
