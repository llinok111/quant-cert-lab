// Timing harness: warmup 1, then 9 measured samples, cold start recorded separately.
// All numbers in bench/result.json come from this run.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeBounds, quantizePositions, dequantizePositions, measureError, certify, chooseBits,
} from '../src/core.mjs';
import { sharedBounds, quantizeShared, bruteError } from '../baseline/naive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DATA = resolve(ROOT, 'data', 'meshes.json');

const doc = JSON.parse(readFileSync(DATA, 'utf8'));
const meshes = doc.meshes.map((m) => ({ name: m.name, positions: Float32Array.from(m.positions) }));
const BITS = 12;
const TARGET_DIV = 1e4;
const REPEAT = 200;
const SAMPLES = 9;
const PICK_REPEAT = 2000;
const WARMUP = 1;

const now = () => Number(process.hrtime.bigint()) / 1e6;

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function p95(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}
function stats(a) {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  return { samples: a.length, min: Math.min(...a), median: median(a), p95: p95(a), max: Math.max(...a), mean: m, stddev: sd, rsd: sd / m };
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;

function encodeCorpus() {
  const encs = [];
  for (const m of meshes) encs.push(quantizePositions(m.positions, BITS));
  return encs;
}
function decodeCorpus(encs) {
  let max = 0;
  for (let i = 0; i < encs.length; i += 1) {
    const dec = dequantizePositions(encs[i]);
    const e = measureError(meshes[i].positions, dec);
    if (e.max > max) max = e.max;
  }
  return max;
}
function certifyCorpus() {
  let worst = 0;
  for (const m of meshes) {
    const c = certify(m.positions, quantizePositions(m.positions, BITS));
    worst = Math.max(worst, c.tightness);
  }
  return worst;
}
function chooseCorpus() {
  const picks = [];
  for (const m of meshes) {
    const b = computeBounds(m.positions);
    picks.push(chooseBits(m.positions, b.diagonal / TARGET_DIV).bits);
  }
  return picks;
}
function baselineCorpus() {
  const shared = sharedBounds(meshes.map((m) => ({ positions: m.positions })));
  let max = 0;
  for (const m of meshes) {
    const dec = quantizeShared(m.positions, shared, BITS);
    const e = bruteError(m.positions, dec);
    max = Math.max(max, e.max);
  }
  return max;
}

// ---- cold start: very first encode of the corpus ------------------------------
const cold0 = now();
const coldEncs = encodeCorpus();
const coldMs = now() - cold0;

// ---- warmup -------------------------------------------------------------------
for (let i = 0; i < WARMUP; i += 1) {
  encodeCorpus();
  decodeCorpus(coldEncs);
  certifyCorpus();
  chooseCorpus();
  baselineCorpus();
}

const encTimes = [];
const decTimes = [];
const certTimes = [];
const pickTimes = [];
const baseTimes = [];
let lastMax = 0;
let lastPick = null;
let lastTight = 0;
let lastBaselineMax = 0;
for (let s = 0; s < SAMPLES; s += 1) {
  let t = now();
  let encs = null;
  for (let r = 0; r < REPEAT; r += 1) encs = encodeCorpus();
  encTimes.push((now() - t) / REPEAT);

  t = now();
  for (let r = 0; r < REPEAT; r += 1) lastMax = decodeCorpus(encs);
  decTimes.push((now() - t) / REPEAT);

  t = now();
  for (let r = 0; r < REPEAT; r += 1) lastTight = certifyCorpus();
  certTimes.push((now() - t) / REPEAT);

  t = now();
  for (let r = 0; r < PICK_REPEAT; r += 1) lastPick = chooseCorpus();
  pickTimes.push((now() - t) / PICK_REPEAT);

  t = now();
  for (let r = 0; r < REPEAT; r += 1) lastBaselineMax = baselineCorpus();
  baseTimes.push((now() - t) / REPEAT);
}

const encStats = stats(encTimes);
const decStats = stats(decTimes);
const certStats = stats(certTimes);
const pickStats = stats(pickTimes);
const baseStats = stats(baseTimes);

// ---- byte accounting ----------------------------------------------------------
const float32Bytes = meshes.reduce((s, m) => s + m.positions.length * 4, 0);
let packed12 = 0;
let packed16 = 0;
for (const m of meshes) {
  packed12 += quantizePositions(m.positions, 12).bytes;
  packed16 += quantizePositions(m.positions, 16).bytes;
}
const vertexCount = meshes.reduce((s, m) => s + m.positions.length / 3, 0);

// ---- per-bit certificate table + shared-bounds 8-bit violations --------------
const perBits = [];
for (const m of meshes) {
  const b = computeBounds(m.positions);
  for (const bits of [8, 10, 12, 16]) {
    const c = certify(m.positions, quantizePositions(m.positions, bits));
    perBits.push({
      mesh: m.name, bits,
      diagonal: r6(b.diagonal),
      declaredBound: c.bound,
      measuredMax: c.measuredMax,
      tightness: r6(c.tightness),
      violations: c.violations,
      bytes: quantizePositions(m.positions, bits).bytes,
    });
  }
}
const sharedBox = sharedBounds(meshes.map((m) => ({ positions: m.positions })));
let sharedViolations = 0;
let sharedWorstRatio = 0;
for (const m of meshes) {
  const enc = quantizePositions(m.positions, 8);
  const target = enc.declared.boundWithUnit;
  const dec = quantizeShared(m.positions, sharedBox, 8);
  let viol = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    const d = Math.hypot(m.positions[i] - dec[i], m.positions[i + 1] - dec[i + 1], m.positions[i + 2] - dec[i + 2]);
    if (d > target) viol += 1;
  }
  sharedViolations += viol;
  sharedWorstRatio = Math.max(sharedWorstRatio, bruteError(m.positions, dec).max / target);
}

const result = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  corpus: {
    meshes: meshes.length,
    vertices: vertexCount,
    bits: BITS,
    targetDivisor: TARGET_DIV,
    repeatPerSample: REPEAT,
    chooseRepeatPerSample: PICK_REPEAT,
    warmup: WARMUP,
    samples: SAMPLES,
  },
  coldStartMs: r6(coldMs),
  ops: {
    encode: { ...encStats, unit: 'ms per corpus encode (12-bit + bit-pack)' },
    decodeMeasure: { ...decStats, unit: 'ms per corpus decode (unpack + dequant + error)' },
    certify: { ...certStats, unit: 'ms per corpus certify' },
    chooseBits: { ...pickStats, repeatPerSample: PICK_REPEAT, unit: 'ms per corpus minimal-depth solve' },
    baselineShared: { ...baseStats, unit: 'ms per corpus shared-bounds quantize + oracle error' },
  },
  bytes: {
    float32: float32Bytes,
    packed12,
    packed16,
    savings12Pct: r6((1 - packed12 / float32Bytes) * 100),
    savings16Pct: r6((1 - packed16 / float32Bytes) * 100),
    packed12Ratio: r6(packed12 / float32Bytes),
  },
  perBits,
  sharedBaseline8bit: {
    sharedBoxSize: sharedBox.size.map(r6),
    violations: sharedViolations,
    vertices: vertexCount,
    worstErrorRatio: r6(sharedWorstRatio),
  },
  certificate: {
    bits: BITS,
    worstTightness: r6(lastTight),
    corpusMeasuredMax: lastMax,
    chosenBits: lastPick,
    baselineSharedMeasuredMax: lastBaselineMax,
  },
};

writeFileSync(resolve(HERE, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);

const fmt = (s) => `median=${s.median.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms min=${s.min.toFixed(3)}ms max=${s.max.toFixed(3)}ms sd=${s.stddev.toFixed(3)} rsd=${(s.rsd * 100).toFixed(2)}%`;
console.log(`cold start encode: ${coldMs.toFixed(3)} ms`);
console.log(`encode  (12-bit) : ${fmt(encStats)}`);
console.log(`decode+measure   : ${fmt(decStats)}`);
console.log(`certify          : ${fmt(certStats)}`);
console.log(`chooseBits       : ${fmt(pickStats)}`);
console.log(`baseline shared  : ${fmt(baseStats)}`);
console.log(`bytes: float32=${float32Bytes} packed12=${packed12} (${result.bytes.savings12Pct.toFixed(2)}% smaller) packed16=${packed16} (${result.bytes.savings16Pct.toFixed(2)}% smaller)`);
console.log(`certificate: worst tightness=${lastTight.toFixed(3)} max error=${lastMax.toExponential(3)} chosen bits=${JSON.stringify(lastPick)}`);
console.log(`wrote ${resolve(HERE, 'result.json')}`);
