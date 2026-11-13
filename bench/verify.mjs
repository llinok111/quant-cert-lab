// Assertions over the six sample primitives. Every printed number is measured here.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeBounds, declaredError, packBits, unpackBits, quantizePositions,
  dequantizePositions, measureError, certify, chooseBits, HEADER_BYTES,
} from '../src/core.mjs';
import { sharedBounds, quantizeShared, bruteError } from '../baseline/naive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DATA = resolve(ROOT, 'data', 'meshes.json');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`PASS ${name} :: ${detail}`); }
  else { failed += 1; console.log(`FAIL ${name} :: ${detail}`); }
}

const doc = JSON.parse(readFileSync(DATA, 'utf8'));
const meshes = doc.meshes.map((m) => ({ name: m.name, positions: Float32Array.from(m.positions) }));
const totalVerts = meshes.reduce((s, m) => s + m.positions.length / 3, 0);
console.log(`# corpus: meshes=${meshes.length} vertices=${totalVerts} seed=${doc.seed}`);

check('corpus-size', meshes.length === 6 && totalVerts === 6064,
  `meshes=${meshes.length} vertices=${totalVerts} (expected 6 / 6064)`);

// --- 1. bit packing is lossless -------------------------------------------------
const rnd = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; }; })();
let roundtripBad = 0;
for (let bits = 1; bits <= 16; bits += 1) {
  const vals = new Uint32Array(500);
  const maxQ = 2 ** bits - 1;
  for (let i = 0; i < vals.length; i += 1) vals[i] = rnd() % (maxQ + 1);
  const back = unpackBits(packBits(vals, bits), vals.length, bits);
  for (let i = 0; i < vals.length; i += 1) if (back[i] !== vals[i]) roundtripBad += 1;
}
check('pack-roundtrip', roundtripBad === 0,
  `16 bit depths x 500 values = 8000 values, mismatches=${roundtripBad}`);

// --- 2. certificate never under-reports ----------------------------------------
const combos = [];
for (const m of meshes) {
  const b = computeBounds(m.positions);
  check(`bounds-${m.name}`, b.diagonal > 0 && b.size.every((s) => s > 0),
    `size=[${b.size.map((v) => v.toFixed(3)).join(', ')}] diag=${b.diagonal.toFixed(3)} maxAbs=${b.maxAbs.toFixed(3)}`);
  for (const bits of [8, 10, 12, 16]) {
    const enc = quantizePositions(m.positions, bits);
    const c = certify(m.positions, enc);
    combos.push({ m, bits, enc, c });
    check(`cert-${m.name}-b${bits}`, c.violations === 0 && c.measuredMax <= c.bound && c.tightness > 0.5 && c.tightness <= 1,
      `bound=${c.bound.toExponential(4)} measuredMax=${c.measuredMax.toExponential(4)} tightness=${c.tightness.toFixed(3)} violations=${c.violations}`);
  }
}
console.log(`# certificate combos: ${combos.length}, tightness range ${Math.min(...combos.map((x) => x.c.tightness)).toFixed(3)}..${Math.max(...combos.map((x) => x.c.tightness)).toFixed(3)}`);

// --- 3. independent oracle (baseline module, own loop) --------------------------
let worstOracle = 0;
for (const { m, enc, c } of combos) {
  const dec = dequantizePositions(enc);
  const own = measureError(m.positions, dec);
  const oracle = bruteError(m.positions, dec);
  worstOracle = Math.max(worstOracle, Math.abs(own.max - oracle.max));
  check(`oracle-${m.name}-b${enc.bits}`, Math.abs(own.max - oracle.max) <= 1e-12 * Math.max(1, computeBounds(m.positions).diagonal),
    `core.max=${own.max.toExponential(6)} oracle.max=${oracle.max.toExponential(6)} delta=${Math.abs(own.max - oracle.max).toExponential(2)}`);
}
console.log(`# oracle worst absolute delta over ${combos.length} combos: ${worstOracle.toExponential(2)}`);

// --- 4. minimal bit depth meets the target, and depth-1 does not ----------------
let chooseOk = 0;
const chooseRows = [];
for (const m of meshes) {
  const b = computeBounds(m.positions);
  for (const div of [1e3, 1e4]) {
    const target = b.diagonal / div;
    const pick = chooseBits(m.positions, target);
    const c = certify(m.positions, quantizePositions(m.positions, pick.bits));
    const ok = pick.feasible && pick.minimal && c.measuredMax <= target;
    if (ok) chooseOk += 1;
    chooseRows.push(`${m.name}@${div === 1e3 ? '1e-3' : '1e-4'}:bits=${pick.bits}`);
    check(`choose-${m.name}-${div}`, ok,
      `target=${target.toExponential(3)} bits=${pick.bits} prevBound=${pick.previousBound.toExponential(3)} actualMax=${c.measuredMax.toExponential(3)} minimal=${pick.minimal}`);
  }
}
check('choose-all', chooseOk === 12, `${chooseOk}/12 targets met with the minimal depth`);

// --- 5. scale invariance 1e-6 .. 1e6 -------------------------------------------
const scales = [1e-6, 1e-3, 1, 1e3, 1e6];
let scaleOk = 0;
const scaleRows = [];
for (const m of meshes) {
  const b = computeBounds(m.positions);
  const basePick = chooseBits(m.positions, b.diagonal / 1e4);
  for (const s of scales) {
    const scaled = Float32Array.from(m.positions, (v) => v * s);
    const sb = computeBounds(scaled);
    const pick = chooseBits(scaled, sb.diagonal / 1e4);
    const cert = certify(scaled, quantizePositions(scaled, pick.bits));
    const ok = pick.bits === basePick.bits && cert.violations === 0 && cert.measuredMax <= pick.targetError;
    if (ok) scaleOk += 1;
    scaleRows.push(`${m.name}@${s}:${pick.bits}`);
    check(`scale-${m.name}-${s}`, ok,
      `bits=${pick.bits} (unit=${basePick.bits}) bound=${cert.bound.toExponential(2)} target=${pick.targetError.toExponential(2)} violations=${cert.violations}`);
  }
}
check('scale-all', scaleOk === 30, `${scaleOk}/30 (6 meshes x 5 scales) keep the same bit depth and stay certified`);

// --- 6. shared-bounds baseline breaks the per-primitive certificate -------------
const sceneMeshes = meshes.map((m) => ({ positions: m.positions }));
const shared = sharedBounds(sceneMeshes);
let sharedViol = 0;
let worstRatio = 0;
let sharedVerts = 0;
for (const m of meshes) {
  const enc = quantizePositions(m.positions, 8);
  const target = enc.declared.boundWithUnit;
  const dec = quantizeShared(m.positions, shared, 8);
  let viol = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    const d = Math.hypot(m.positions[i] - dec[i], m.positions[i + 1] - dec[i + 1], m.positions[i + 2] - dec[i + 2]);
    if (d > target) viol += 1;
  }
  const oracle = bruteError(m.positions, dec);
  const ratio = oracle.max / target;
  worstRatio = Math.max(worstRatio, ratio);
  sharedViol += viol;
  sharedVerts += m.positions.length / 3;
  check(`shared8-${m.name}`, viol > 0,
    `per-primitive 8-bit bound=${target.toExponential(3)} shared-bounds max=${oracle.max.toExponential(3)} ratio=${ratio.toFixed(2)} violations=${viol}/${m.positions.length / 3}`);
}
console.log(`# shared box size=[${shared.size.map((v) => v.toFixed(3)).join(', ')}]`);
check('shared-total', sharedViol >= 400 && worstRatio >= 1.5,
  `shared-bounds 8-bit violations=${sharedViol}/${sharedVerts} worst error ratio=${worstRatio.toFixed(2)}x`);

// --- 7. byte accounting --------------------------------------------------------
const torus = meshes[0];
for (const bits of [8, 12, 16]) {
  const enc = quantizePositions(torus.positions, bits);
  const expect = Math.ceil((torus.positions.length * bits) / 8) + HEADER_BYTES;
  check(`bytes-${bits}`, enc.bytes === expect,
    `vertices=${torus.positions.length / 3} bits=${bits} payload=${enc.payloadBytes}B header=${HEADER_BYTES}B total=${enc.bytes}B float32=${torus.positions.length * 4}B ratio=${(enc.bytes / (torus.positions.length * 4)).toFixed(3)}`);
}

// --- 8. generator determinism --------------------------------------------------
const hash = () => createHash('sha256').update(readFileSync(DATA)).digest('hex').slice(0, 16);
const h1 = hash();
execFileSync(process.execPath, [resolve(ROOT, 'tools', 'gen-sample.mjs')], { cwd: ROOT });
const h2 = hash();
check('generator-deterministic', h1 === h2, `sha256[0:16] before=${h1} after=${h2}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
