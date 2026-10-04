import { defineConfig } from "tsdown";

export default defineConfig({
	entry: "./src/index.ts",
	format: "esm",
	outDir: "./dist",
	clean: true,
	// Bundle every dependency except varlock: `varlock/auto-load` runs the varlock CLI at startup.
	// The deploy artifact is then dist/, .env.schema, and node_modules/varlock (see health-deploy.yml).
	deps: {
		alwaysBundle: [/^(?!varlock(\/|$))/],
	},
});
