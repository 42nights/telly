// Merges Bun lcov reports (unit and db:test) into coverage/lcov.info and prints line and function
// coverage per package. Bun reports only files that a test loaded, so every tracked source file
// that no test loaded is added at 0%, and the percentages count it.
// Usage: bun scripts/coverage-summary.ts [--min <percent>] <lcov.info>...
// With --min, the exit code is 1 when any package is below that percent for lines or functions.
import { readFileSync, writeFileSync } from "node:fs";

const PACKAGES = [
	"apps/server",
	"apps/web",
	"packages/contracts",
	"packages/db",
	"packages/ui",
	"spacetimedb",
];

const args = process.argv.slice(2);
const minAt = args.indexOf("--min");
const min = minAt === -1 ? undefined : Number(args.splice(minAt, 2)[1]);
if (args.length === 0 || (min !== undefined && Number.isNaN(min)))
	throw new Error(
		"Usage: bun scripts/coverage-summary.ts [--min <percent>] <lcov.info>...",
	);

type FileCoverage = {
	/** Line number to hit count, for each line Bun counts as code. */
	lines: Map<number, number>;
	fnf: number;
	fnh: number;
	/** False for a tracked source file that no test loaded. */
	loaded: boolean;
};
const files = new Map<string, FileCoverage>();

for (const report of args)
	for (const record of readFileSync(report, "utf8").split("end_of_record")) {
		const name = /^SF:(.+)$/m.exec(record)?.[1];
		if (!name) continue;
		const file = files.get(name) ?? {
			lines: new Map(),
			fnf: 0,
			fnh: 0,
			loaded: true,
		};
		files.set(name, file);
		for (const [, line, hits] of record.matchAll(/^DA:(\d+),(\d+)/gm))
			file.lines.set(
				Number(line),
				(file.lines.get(Number(line)) ?? 0) + Number(hits),
			);
		// ponytail: Bun's lcov has no per-function records, only FNF and FNH totals, so a merge
		// keeps the best report per file; a function hit only in another report is not added.
		file.fnf = Math.max(
			file.fnf,
			Number(/^FNF:(\d+)$/m.exec(record)?.[1] ?? 0),
		);
		file.fnh = Math.max(
			file.fnh,
			Number(/^FNH:(\d+)$/m.exec(record)?.[1] ?? 0),
		);
	}

const tracked = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx"])
	.stdout.toString()
	.split("\n")
	.filter(
		(path) =>
			PACKAGES.some((root) => path.startsWith(`${root}/src/`)) &&
			!/\.(test|spec)\.tsx?$|\.d\.ts$|routeTree\.gen\.ts$/.test(path),
	);
for (const path of tracked) {
	if (files.has(path)) continue;
	// ponytail: an unloaded file has no Bun line map, so every non-blank, non-comment line counts as
	// code and every `=>` or `function` as a function. That overcounts a little; a test that loads
	// the file replaces the estimate with Bun's numbers.
	const source = readFileSync(path, "utf8");
	const lines = new Map<number, number>();
	source.split("\n").forEach((text, index) => {
		if (/^\s*$|^\s*(\/\/|\/\*|\*)/.test(text)) return;
		lines.set(index + 1, 0);
	});
	files.set(path, {
		lines,
		fnf: source.match(/=>|\bfunction\b/g)?.length ?? 0,
		fnh: 0,
		loaded: false,
	});
}

let lcov = "";
for (const [name, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
	const das = [...file.lines].sort(([a], [b]) => a - b);
	const hit = das.filter(([, count]) => count > 0).length;
	lcov += `SF:${name}\nFNF:${file.fnf}\nFNH:${file.fnh}\n${das.map(([line, count]) => `DA:${line},${count}\n`).join("")}LF:${das.length}\nLH:${hit}\nend_of_record\n`;
}
writeFileSync("coverage/lcov.info", lcov);

const pct = (hit: number, found: number) =>
	found === 0 ? 100 : (100 * hit) / found;
const rows = [...PACKAGES, "All files"].map((root) => {
	const total = { lf: 0, lh: 0, fnf: 0, fnh: 0, files: 0, unloaded: 0 };
	for (const [name, file] of files) {
		const inRoot =
			root === "All files"
				? PACKAGES.some((p) => name.startsWith(`${p}/`))
				: name.startsWith(`${root}/`);
		if (!inRoot) continue;
		const lines = [...file.lines.values()];
		total.files++;
		if (!file.loaded) total.unloaded++;
		total.lf += lines.length;
		total.lh += lines.filter((count) => count > 0).length;
		total.fnf += file.fnf;
		total.fnh += file.fnh;
	}
	return { root, ...total };
});
console.log("package            | % lines | % funcs | files | unloaded (0%)");
for (const row of rows)
	console.log(
		`${row.root.padEnd(18)} | ${pct(row.lh, row.lf).toFixed(2).padStart(7)} | ${pct(row.fnh, row.fnf).toFixed(2).padStart(7)} | ${String(row.files).padStart(5)} | ${row.unloaded}`,
	);
if (min !== undefined) {
	const below = rows.filter(
		(row) => pct(row.lh, row.lf) < min || pct(row.fnh, row.fnf) < min,
	);
	for (const row of below)
		console.log(`::error::${row.root} coverage is below ${min}%`);
	if (below.length > 0) process.exit(1);
}
