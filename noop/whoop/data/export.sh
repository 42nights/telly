#!/bin/sh
set -eu
DB=${1:-$HOME/whoop-feed/noop.sqlite}
OUT=$(dirname "$0")
FROM=${2:-1790675245}
TO=${3:-1790678845}

q() { sqlite3 -json "$DB" "$2" > "$OUT/$1.json"; }

q pairedDevice "select brand, model, capabilities, status from pairedDevice"
for t in dailyMetric metricSeries sleepSession liveSession scoreInputProvenance battery event ppgHrSample; do
  q "$t" "select * from $t"
done
for t in hrSample rrInterval skinTempSample gravitySample stepSample sleepStateSample; do
  q "$t" "select * from $t where ts between $FROM and $TO"
done
q ppgWaveformSample "select deviceId, ts, hex(samples) as samplesHex, burstIndex, baseCode from ppgWaveformSample where ts between $FROM and $TO"
q v18AuxSample "select deviceId, ts, hex(fields) as fieldsHex from v18AuxSample where ts between $FROM and $TO"
