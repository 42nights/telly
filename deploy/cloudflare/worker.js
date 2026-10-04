// Worker `telly` on the 42nights Cloudflare account (deploy/cloudflare/deploy.sh). It serves the web
// app from static assets and sends /health and /api/* to the Node API, which runs in one Cloudflare
// Container. The container pulls its own keys at start (deploy/cloudflare/entrypoint.sh). On
// LANDING_HOST it serves the static landing page (deploy/cloudflare/landing/) instead of the app.
const port = 8080;
// Public settings the API needs; deploy.sh puts them in the Worker's vars.
const passed = [
	"CORS_ORIGIN",
	"OIDC_ISSUER",
	"OIDC_AUDIENCE",
	"SPACETIMEDB_URI",
	"SPACETIMEDB_DATABASE",
	"FINCHNODE_MODE",
	"TELLY_R2_ACCOUNT_ID",
	"TELLY_R2_BUCKET",
	"TELLY_R2_ACCESS_KEY_ID",
	"SPECTRUM_PROJECT_ID",
	"QWEN_BASE_URL",
	"QWEN_BASE_MODEL",
	"QWEN_CHECKPOINT",
	"TELLY_FETCH_BRIDGE_URL",
	"TELLY_SECRETS_URL",
	"TELLY_PULL_KEYS",
	"TELLY_SECRETS_PULL_TOKEN",
];

// After the last request, the container keeps running this long, so work that a request started
// in the background (an iMessage reply after the webhook's 200) can finish.
const inactivityTimeoutMs = 10 * 60 * 1000;

export class Api {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
		// A restarted Durable Object forgets the timeout of a container that is still running.
		if (ctx.container.running)
			void ctx.blockConcurrencyWhile(() => this.keepAfterRequests());
	}

	// A failure here only shortens how long the container stays up; it must not fail the request.
	async keepAfterRequests() {
		try {
			await this.ctx.container.setInactivityTimeout(inactivityTimeoutMs);
		} catch (error) {
			console.log(
				`could not set the container inactivity timeout: ${String(error).slice(0, 200)}`,
			);
		}
	}

	async start(deploy) {
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
		this.ctx.container
			.monitor()
			.then(() => console.log("the API container exited"))
			.catch((error) =>
				console.log(`the API container failed: ${String(error).slice(0, 300)}`),
			);
		await this.keepAfterRequests();
	}

	async fetch(request) {
		const container = this.ctx.container;
		const tcp = container.getTcpPort(port);
		// Wait for the server before the request, so a request body is never sent twice.
		// ponytail: fixed 60 s start budget (a first start after deploy took ~35 s); tune if measured.
		const deadline = Date.now() + 60_000;
		let failure = "";
		for (;;) {
			if (!container.running) await this.start(this.env.TELLY_DEPLOY_ID);
			try {
				const response = await tcp.fetch("http://api/health", {
					signal: AbortSignal.timeout(3_000),
				});
				if (response.ok) break;
				failure = `HTTP ${response.status}`;
			} catch (error) {
				failure = String(error).slice(0, 200);
			}
			if (Date.now() > deadline) {
				console.log(
					`the API container did not answer /health within 60 s: ${failure}`,
				);
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

// A missing file is a 404, so a page of an older build that asks for a removed chunk sees the
// failure instead of index.html, which the browser refuses as JavaScript. Only a page navigation (no
// file extension, Accept text/html) gets the app's index.html for its client-side route.
async function app(request, env) {
	const response = await env.ASSETS.fetch(request);
	if (
		response.status !== 404 ||
		/\.[a-z0-9]+$/i.test(new URL(request.url).pathname) ||
		!request.headers.get("Accept")?.includes("text/html")
	)
		return response;
	await response.body?.cancel();
	return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
}

// Extensionless pages of the landing (deploy/cloudflare/landing/); /privacy and /terms are the
// links that Google's OAuth consent screen needs.
const landingPages = new Set(["/", "/privacy", "/terms"]);

export default {
	fetch(request, env) {
		const url = new URL(request.url);
		const { pathname } = url;
		if (url.hostname === env.LANDING_HOST) {
			// Landing files have an extension, except the `landingPages`; any other path is an app
			// route, so it goes to the app.
			if (!landingPages.has(pathname) && !/\.[a-z0-9]+$/i.test(pathname))
				return Response.redirect(
					`https://app.${env.LANDING_HOST}${pathname}${url.search}`,
					302,
				);
			// `/landing/` serves landing/index.html and `/landing/privacy` serves landing/privacy.html
			// (asset html_handling redirects paths that end in `.html`).
			url.pathname = `/landing${pathname}`;
			return env.ASSETS.fetch(new Request(url, request));
		}
		if (pathname === "/health" || pathname.startsWith("/api/"))
			// One Durable Object, and so one container, per deploy: a deploy never reuses a
			// container that started with older settings. The previous one stops when idle.
			return env.API.get(env.API.idFromName(env.TELLY_DEPLOY_ID)).fetch(
				request,
			);
		return app(request, env);
	},
	// The cron in deploy.sh (`telly` only) asks the API for /health every 5 minutes. Each request
	// restarts the 10-minute inactivity timer, so the container never sleeps and a reply never
	// waits for a cold start. It also starts the container again after a crash.
	async scheduled(_controller, env) {
		const response = await env.API.get(
			env.API.idFromName(env.TELLY_DEPLOY_ID),
		).fetch("http://api/health");
		await response.body?.cancel();
		if (!response.ok) console.log(`keep-warm /health: HTTP ${response.status}`);
	},
};
