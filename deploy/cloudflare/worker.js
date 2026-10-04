// Worker `telly` on the 42nights Cloudflare account (deploy/cloudflare/deploy.sh). It serves the web
// app from static assets and sends /health and /api/* to the Node API, which runs in one Cloudflare
// Container. The container pulls its own keys at start (deploy/cloudflare/entrypoint.sh).
const port = 8080;
// Public settings the API needs; deploy.sh puts them in the Worker's vars.
const passed = [
	"CORS_ORIGIN",
	"OIDC_ISSUER",
	"OIDC_AUDIENCE",
	"SPACETIMEDB_URI",
	"SPACETIMEDB_DATABASE",
	"FINCHNODE_MODE",
	"TELLY_SECRETS_URL",
	"TELLY_PULL_KEYS",
	"TELLY_SECRETS_PULL_TOKEN",
];

export class Api {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}

	start(deploy) {
		console.log(`starting the API container for deploy ${deploy}`);
		this.ctx.container.start({
			enableInternet: true,
			env: {
				NODE_ENV: "production",
				HOST: "0.0.0.0",
				PORT: String(port),
				...Object.fromEntries(passed.map((name) => [name, this.env[name]])),
			},
		});
	}

	async fetch(request) {
		const container = this.ctx.container;
		// A running container keeps the settings it started with, so a new deploy restarts it.
		const deploy = this.env.TELLY_DEPLOY_ID;
		if (
			container.running &&
			(await this.ctx.storage.get("deploy")) !== deploy
		) {
			console.log("stopping the container of the previous deploy");
			await container.destroy();
		}
		await this.ctx.storage.put("deploy", deploy);
		const tcp = container.getTcpPort(port);
		// Wait for the server before the request, so a request body is never sent twice. A
		// container that stopped, for example while the previous one shut down, starts again.
		// ponytail: fixed 60 s start budget (a first start after deploy took ~35 s); tune if measured.
		const deadline = Date.now() + 60_000;
		for (;;) {
			if (!container.running) this.start(deploy);
			const ready = await tcp
				.fetch("http://api/health", { signal: AbortSignal.timeout(3_000) })
				.then((response) => response.ok)
				.catch(() => false);
			if (ready) break;
			if (Date.now() > deadline) {
				console.log("the API container did not answer /health within 60 s");
				return Response.json(
					{ error: "unavailable", message: "The API did not start" },
					{ status: 503 },
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		// The container accepts plain HTTP only; the hop stays inside Cloudflare.
		const url = new URL(request.url);
		url.protocol = "http:";
		return tcp.fetch(new Request(url, request));
	}
}

export default {
	fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === "/health" || pathname.startsWith("/api/"))
			return env.API.get(env.API.idFromName("api")).fetch(request);
		return env.ASSETS.fetch(request);
	},
};
