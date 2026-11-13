// Baseline strategy for the comparison in bench/: ONE shared bounds box for a whole
// scene of primitives (the obvious "quantize everything the same way" approach),
// and the float32 storage baseline. No certificate: it just reports what it gets.
//
// This file is deliberately independent of src/core.mjs (own clamp/round/measure
// code) so that "baseline error" is not derived from the optimised implementation.
import { readFileSync } from 'node:fs';

export function loadMeshes(file) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  return doc.meshes.map((m) => ({
    name: m.name,
    positions: Float32Array.from(m.positions),
    indices: m.indices,
  }));
}

export function sharedBounds(meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let a = 0; a < 3; a += 1) {
        const v = m.positions[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// Plain round-to-grid quantization against a shared box, stored as float32.
export function quantizeShared(positions, bounds, bits) {
  const maxQ = 2 ** bits - 1;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const size = bounds.size[a];
      const t = size === 0 ? 0 : (positions[i + a] - bounds.min[a]) / size;
      const q = Math.min(maxQ, Math.max(0, Math.round(t * maxQ)));
      out[i + a] = bounds.min[a] + (q / maxQ) * size;
    }
  }
  return out;
}

// Standalone error loop: intentionally not the core's measureError.
export function bruteError(original, decoded) {
  let max = 0;
  let sum = 0;
  for (let i = 0; i < original.length; i += 3) {
    const dx = original[i] - decoded[i];
    const dy = original[i + 1] - decoded[i + 1];
    const dz = original[i + 2] - decoded[i + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > max) max = d2;
    sum += d2;
  }
  const n = original.length / 3;
  return { max: Math.sqrt(max), rms: Math.sqrt(sum / n), count: n };
}
