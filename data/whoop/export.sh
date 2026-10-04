#!/bin/sh
set -eu
DB=${1:-$HOME/telly-host/live.sqlite}
OUT=$(dirname "$0")

q() { sqlite3 -readonly -json "$DB" "$2" > "$OUT/$1.json"; }

q pairedDevice "select brand, model, capabilities, status, addedAt, lastSeenAt from pairedDevice"
for t in dailyMetric metricSeries sleepSession liveSession scoreInputProvenance battery event \
  hrSample rrInterval ppgHrSample skinTempSample gravitySample stepSample sleepStateSample; do
  q "$t" "select * from $t"
done
q ppgWaveformSample "select deviceId, ts, hex(samples) as samplesHex, burstIndex, baseCode from ppgWaveformSample"
q v18AuxSample "select deviceId, ts, hex(fields) as fieldsHex from v18AuxSample"
