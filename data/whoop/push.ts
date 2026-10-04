// Pushes the WHOOP history exported in this folder into one Telly family, through the same ingest
// that NOOP's live push uses. Only real exported rows are sent; the server keeps one heart rate a
// minute, wrist on/off events, and the daily scores, all marked "unvalidated".
// Usage: bun data/whoop/push.ts '<push URL>'
// The push URL is the `url=` value of the NOOP link that Telly shows under Setup → WHOOP → Connect:
// https://api.saintess.tech/api/noop/ingest?k=<token>. A second run sends nothing new.
import { deflateRawSync } from "node:zlib";

const url = process.argv[2];
if (url === undefined || !/\/api\/noop\/ingest\?k=./.test(url)) {
	console.error("usage: bun data/whoop/push.ts '<push URL from Telly>'");
	process.exit(1);
}

const rows = async (table: string): Promise<unknown[]> =>
	JSON.parse(await Bun.file(new URL(`${table}.json`, import.meta.url)).text());

const send = async (tables: Record<string, unknown[]>) => {
	const reply = await fetch(url, {
		method: "POST",
		body: deflateRawSync(JSON.stringify({ tables })),
	});
	if (reply.status !== 200)
		throw new Error(`ingest answered ${reply.status}: ${await reply.text()}`);
};

await send({ dailyMetric: await rows("dailyMetric"), event: await rows("event") });
console.log("sent daily scores and band events");

// About 100 minutes of once-a-second readings per request; the server keeps one a minute.
const CHUNK = 6000;
const heartRate = await rows("hrSample");
for (let start = 0; start < heartRate.length; start += CHUNK) {
	await send({ hrSample: heartRate.slice(start, start + CHUNK) });
	console.log(
		`sent heart rate ${Math.min(start + CHUNK, heartRate.length)}/${heartRate.length}`,
	);
}
