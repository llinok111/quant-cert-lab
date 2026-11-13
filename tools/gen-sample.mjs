// Deterministic sample geometry generator. Fixed seed -> byte-identical output on re-run.
// Output: data/meshes.json  { version, seed, meshes: [{ name, positions:[x,y,z,...], indices:[...] }] }
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'data', 'meshes.json');
const SEED = 20261113;

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v) => Math.round(v * 1e7) / 1e7;

function gridIndices(nu, nv, closedU = true, closedV = false) {
  const idx = [];
  const uCount = closedU ? nu : nu - 1;
  const vCount = closedV ? nv : nv - 1;
  for (let i = 0; i < uCount; i += 1) {
    for (let j = 0; j < vCount; j += 1) {
      const i0 = i % nu;
      const i1 = (i + 1) % nu;
      const j0 = j % nv;
      const j1 = (j + 1) % nv;
      const a = j0 * nu + i0;
      const b = j0 * nu + i1;
      const c = j1 * nu + i1;
      const d = j1 * nu + i0;
      idx.push(a, b, c, a, c, d);
    }
  }
  return idx;
}

function torus(nu = 48, nv = 24, R = 1, r = 0.35) {
  const positions = [];
  for (let j = 0; j < nv; j += 1) {
    const v = (j / nv) * Math.PI * 2;
    for (let i = 0; i < nu; i += 1) {
      const u = (i / nu) * Math.PI * 2;
      positions.push(
        round((R + r * Math.cos(v)) * Math.cos(u)),
        round((R + r * Math.cos(v)) * Math.sin(u)),
        round(r * Math.sin(v)),
      );
    }
  }
  return { positions, indices: gridIndices(nu, nv) };
}

function sphere(nu = 40, nv = 20, R = 1) {
  const positions = [];
  for (let j = 0; j <= nv; j += 1) {
    const v = (j / nv) * Math.PI;
    for (let i = 0; i < nu; i += 1) {
      const u = (i / nu) * Math.PI * 2;
      positions.push(
        round(R * Math.sin(v) * Math.cos(u)),
        round(R * Math.sin(v) * Math.sin(u)),
        round(R * Math.cos(v)),
      );
    }
  }
  const rows = nv + 1;
  const idx = [];
  for (let j = 0; j < nv; j += 1) {
    for (let i = 0; i < nu; i += 1) {
      const i1 = (i + 1) % nu;
      const a = j * nu + i;
      const b = j * nu + i1;
      const c = (j + 1) * nu + i1;
      const d = (j + 1) * nu + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  return { positions, indices: idx, rows };
}

function cylinder(nu = 32, h = 1.4, R = 0.6) {
  const positions = [];
  const idx = [];
  const y0 = -h / 2;
  const y1 = h / 2;
  for (const y of [y0, y1]) {
    for (let i = 0; i < nu; i += 1) {
      const a = (i / nu) * Math.PI * 2;
      positions.push(round(R * Math.cos(a)), round(y), round(R * Math.sin(a)));
    }
  }
  for (let i = 0; i < nu; i += 1) {
    const i1 = (i + 1) % nu;
    idx.push(i, i1, nu + i1, i, nu + i1, nu + i);
  }
  for (const [y, flip] of [[y0, true], [y1, false]]) {
    const center = positions.length / 3;
    positions.push(0, round(y), 0);
    const ring = y === y0 ? 0 : nu;
    for (let i = 0; i < nu; i += 1) {
      const i1 = (i + 1) % nu;
      if (flip) idx.push(center, ring + i1, ring + i);
      else idx.push(center, ring + i, ring + i1);
    }
  }
  return { positions, indices: idx };
}

function terrain(n = 40, extent = 2.2, amp = 0.45, seed = SEED) {
  const rnd = mulberry32(seed);
  const positions = [];
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1) - 0.5) * extent;
      const z = (j / (n - 1) - 0.5) * extent;
      const h = amp * (Math.sin(x * 2.1) * Math.cos(z * 1.7) + 0.45 * Math.sin(x * 5.3 + z * 3.1));
      positions.push(round(x + (rnd() - 0.5) * 0.01), round(h), round(z + (rnd() - 0.5) * 0.01));
    }
  }
  return { positions, indices: gridIndices(n, n, false, false) };
}

function helixTube(nSeg = 240, sides = 8, turns = 4, R = 0.9, r = 0.12) {
  const positions = [];
  for (let s = 0; s < nSeg; s += 1) {
    const t = s / nSeg;
    const a = t * Math.PI * 2 * turns;
    const cx = R * Math.cos(a);
    const cy = (t - 0.5) * 2.2;
    const cz = R * Math.sin(a);
    // frame: tangent, normal, binormal
    const tx = -R * Math.sin(a) * Math.PI * 2 * turns;
    const ty = 2.2;
    const tz = R * Math.cos(a) * Math.PI * 2 * turns;
    const tl = Math.hypot(tx, ty, tz);
    const T = [tx / tl, ty / tl, tz / tl];
    const up = Math.abs(T[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let N = [T[1] * up[2] - T[2] * up[1], T[2] * up[0] - T[0] * up[2], T[0] * up[1] - T[1] * up[0]];
    const nl = Math.hypot(...N);
    N = N.map((v) => v / nl);
    const B = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
    for (let k = 0; k < sides; k += 1) {
      const b = (k / sides) * Math.PI * 2;
      positions.push(
        round(cx + r * (Math.cos(b) * N[0] + Math.sin(b) * B[0])),
        round(cy + r * (Math.cos(b) * N[1] + Math.sin(b) * B[1])),
        round(cz + r * (Math.cos(b) * N[2] + Math.sin(b) * B[2])),
      );
    }
  }
  const idx = [];
  for (let s = 0; s < nSeg; s += 1) {
    const s1 = (s + 1) % nSeg;
    for (let k = 0; k < sides; k += 1) {
      const k1 = (k + 1) % sides;
      const a = s * sides + k;
      const b = s * sides + k1;
      const c = s1 * sides + k1;
      const d = s1 * sides + k;
      idx.push(a, b, c, a, c, d);
    }
  }
  return { positions, indices: idx };
}

function bracket(nu = 9, size = 1.6) {
  const positions = [];
  const idx = [];
  const half = size / 2;
  const faces = [
    { axis: 0, sign: 1 }, { axis: 0, sign: -1 },
    { axis: 1, sign: 1 }, { axis: 1, sign: -1 },
    { axis: 2, sign: 1 }, { axis: 2, sign: -1 },
  ];
  for (const { axis, sign } of faces) {
    const base = positions.length / 3;
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (let j = 0; j < nu; j += 1) {
      for (let i = 0; i < nu; i += 1) {
        const p = [0, 0, 0];
        p[axis] = sign * half;
        p[u] = (i / (nu - 1) - 0.5) * size;
        p[v] = (j / (nu - 1) - 0.5) * size;
        positions.push(round(p[0]), round(p[1]), round(p[2]));
      }
    }
    for (let j = 0; j < nu - 1; j += 1) {
      for (let i = 0; i < nu - 1; i += 1) {
        const a = base + j * nu + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = a + nu;
        if (sign > 0) idx.push(a, b, c, a, c, d);
        else idx.push(a, c, b, a, d, c);
      }
    }
  }
  return { positions, indices: idx };
}

const meshes = [
  { name: 'torus', ...torus() },
  { name: 'sphere', ...sphere() },
  { name: 'cylinder', ...cylinder() },
  { name: 'terrain', ...terrain() },
  { name: 'helix-tube', ...helixTube() },
  { name: 'bracket', ...bracket() },
];

const doc = {
  version: 1,
  seed: SEED,
  generator: 'tools/gen-sample.mjs',
  meshes: meshes.map((m) => ({ name: m.name, positions: m.positions, indices: m.indices })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc));
let bytes = 0;
for (const m of doc.meshes) bytes += m.positions.length * 4;
console.log(`wrote ${OUT}`);
console.log(`meshes=${doc.meshes.length} vertices=${doc.meshes.reduce((s, m) => s + m.positions.length / 3, 0)} float32Bytes=${bytes}`);
