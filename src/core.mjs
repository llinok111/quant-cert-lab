// quant-cert-lab core — bit-packed position quantization with an a-priori error certificate.
// Pure computation: no renderer, no DOM, no I/O, no environment access.
//
// Error model (stated below; absolute numbers are disclosed in README):
//   For a primitive whose bounds have size S on one axis and b resolution bits,
//   maxQ = 2^b - 1, the rounding half-step is S / (2 * maxQ).
//   The dequantized coordinate is therefore within that half-step of the original.
//   For the euclidean per-vertex error the bound is sqrt(sum_axis halfStep^2).
//   Decoders store the decoded coordinate as float32; that storage adds at most
//   maxAbs * 2^-24 per coordinate, which we add to the declared bound (float32Allowance).

export const MAX_BITS = 16;
const F32_EPS = 2 ** -24;

export function toPositions(input) {
  if (input instanceof Float32Array) return input;
  if (input instanceof Float64Array) return Float32Array.from(input);
  if (Array.isArray(input)) return Float32Array.from(input);
  if (input && input.positions) return toPositions(input.positions);
  throw new TypeError('positions must be Float32Array, a flat number array, or {positions}');
}

export function computeBounds(input) {
  const p = toPositions(input);
  if (p.length === 0) throw new Error('empty positions');
  if (p.length % 3 !== 0) throw new Error('positions length must be a multiple of 3');
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const min = [minX, minY, minZ];
  const max = [maxX, maxY, maxZ];
  const size = [maxX - minX, maxY - minY, maxZ - minZ];
  return {
    min,
    max,
    size,
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    diagonal: Math.hypot(size[0], size[1], size[2]),
    maxAbs: Math.max(...min.map(Math.abs), ...max.map(Math.abs)),
  };
}

export function normalizeBounds(b) {
  if (!b || !Array.isArray(b.min) || !Array.isArray(b.max)) {
    throw new TypeError('bounds must be {min:[3], max:[3]}');
  }
  const min = b.min.slice(0, 3);
  const max = b.max.slice(0, 3);
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (size.some((s) => s < 0)) throw new Error('bounds max must be >= min');
  return {
    min,
    max,
    size,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    diagonal: Math.hypot(size[0], size[1], size[2]),
    maxAbs: Math.max(...min.map(Math.abs), ...max.map(Math.abs)),
  };
}

export function checkBits(bits) {
  if (!Number.isInteger(bits) || bits < 1 || bits > MAX_BITS) {
    throw new RangeError(`bits must be an integer in 1..${MAX_BITS}, got ${bits}`);
  }
  return bits;
}

// The certificate. Every field here is computed from bounds + bits only, never from data.
export function declaredError(bounds, bits) {
  checkBits(bits);
  const maxQ = 2 ** bits - 1;
  const halfStep = bounds.size.map((s) => s / (2 * maxQ));
  const perAxis = Math.max(halfStep[0], halfStep[1], halfStep[2]);
  const euclidean = Math.hypot(halfStep[0], halfStep[1], halfStep[2]);
  const f32Allowance = bounds.maxAbs * F32_EPS;
  return {
    bits,
    maxQ,
    halfStep,
    perAxis,
    euclidean,
    f32Allowance,
    bound: euclidean + f32Allowance,
    boundWithUnit: euclidean + f32Allowance + bounds.diagonal * 1e-15,
  };
}

export function packBits(values, bits) {
  checkBits(bits);
  const totalBits = values.length * bits;
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  let bitPos = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    for (let k = 0; k < bits; k += 1) {
      if ((v >>> k) & 1) out[bitPos >> 3] |= 1 << (bitPos & 7);
      bitPos += 1;
    }
  }
  return out;
}

export function unpackBits(packed, count, bits) {
  checkBits(bits);
  const out = new Uint32Array(count);
  let bitPos = 0;
  for (let i = 0; i < count; i += 1) {
    let v = 0;
    for (let k = 0; k < bits; k += 1) {
      const bit = (packed[bitPos >> 3] >>> (bitPos & 7)) & 1;
      v |= bit << k;
      bitPos += 1;
    }
    out[i] = v;
  }
  return out;
}

// Quantize into a bit-packed buffer. Header = 6 float32 bounds (24 bytes) + 1 byte bits.
export const HEADER_BYTES = 25;

export function quantizePositions(input, bits, opts = {}) {
  checkBits(bits);
  const p = toPositions(input);
  if (p.length === 0) throw new Error('empty positions');
  if (p.length % 3 !== 0) throw new Error('positions length must be a multiple of 3');
  const bounds = opts.bounds ? normalizeBounds(opts.bounds) : computeBounds(p);
  const maxQ = 2 ** bits - 1;
  const q = new Uint32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const size = bounds.size[a];
      const raw = size === 0 ? 0 : ((p[i + a] - bounds.min[a]) / size) * maxQ;
      q[i + a] = Math.min(maxQ, Math.max(0, Math.round(raw)));
    }
  }
  const packed = packBits(q, bits);
  const cert = declaredError(bounds, bits);
  return {
    bits,
    count: p.length / 3,
    bounds,
    quantized: q,
    packed,
    payloadBytes: packed.length,
    bytes: packed.length + HEADER_BYTES,
    declared: cert,
  };
}

export function dequantizePositions(enc) {
  if (!enc || !enc.packed || !enc.bounds) throw new TypeError('expected a quantizePositions() result');
  const bits = checkBits(enc.bits);
  const maxQ = 2 ** bits - 1;
  const values = unpackBits(enc.packed, enc.count * 3, bits);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const size = enc.bounds.size[a];
      out[i + a] = size === 0
        ? enc.bounds.min[a]
        : enc.bounds.min[a] + (values[i + a] / maxQ) * size;
    }
  }
  return out;
}

// Independent per-vertex measurement of the realised error.
export function measureError(original, decoded) {
  const a = toPositions(original);
  const b = toPositions(decoded);
  if (a.length !== b.length) throw new Error('length mismatch');
  let max = 0, sumSq = 0, maxAxis = 0, worstIndex = -1;
  for (let i = 0; i < a.length; i += 3) {
    const dx = a[i] - b[i];
    const dy = a[i + 1] - b[i + 1];
    const dz = a[i + 2] - b[i + 2];
    const e = Math.hypot(dx, dy, dz);
    if (e > max) { max = e; worstIndex = i / 3; }
    if (Math.abs(dx) > maxAxis) maxAxis = Math.abs(dx);
    if (Math.abs(dy) > maxAxis) maxAxis = Math.abs(dy);
    if (Math.abs(dz) > maxAxis) maxAxis = Math.abs(dz);
    sumSq += e * e;
  }
  const n = a.length / 3;
  return {
    max,
    rms: Math.sqrt(sumSq / n),
    maxAxis,
    worstIndex,
    count: n,
    tightness: null,
  };
}

export function certify(original, enc) {
  const decoded = dequantizePositions(enc);
  const err = measureError(original, decoded);
  const bound = enc.declared.boundWithUnit;
  const violations = err.max > bound ? 1 : 0;
  return {
    bound,
    declaredEuclidean: enc.declared.euclidean,
    f32Allowance: enc.declared.f32Allowance,
    measuredMax: err.max,
    measuredRms: err.rms,
    tightness: bound > 0 ? err.max / bound : 0,
    violations,
    worstIndex: err.worstIndex,
    decoded,
  };
}

// Minimal bit depth whose certificate still meets targetError.
export function chooseBits(input, targetError, opts = {}) {
  if (!(targetError > 0)) throw new RangeError('targetError must be > 0');
  const p = toPositions(input);
  const bounds = opts.bounds ? normalizeBounds(opts.bounds) : computeBounds(p);
  const maxBits = opts.maxBits ? checkBits(opts.maxBits) : MAX_BITS;
  const minBits = opts.minBits ? checkBits(opts.minBits) : 1;
  let chosen = null;
  for (let b = minBits; b <= maxBits; b += 1) {
    if (declaredError(bounds, b).bound <= targetError) { chosen = b; break; }
  }
  if (chosen === null) {
    const best = declaredError(bounds, maxBits).bound;
    return { feasible: false, bits: null, targetError, bestBound: best, reason: 'target below achievable bound' };
  }
  const cert = declaredError(bounds, chosen);
  const prevBound = chosen > 1 ? declaredError(bounds, chosen - 1).bound : null;
  const bytes = Math.ceil((p.length * chosen) / 8) + HEADER_BYTES;
  return {
    feasible: true,
    bits: chosen,
    targetError,
    declared: cert,
    previousBound: prevBound,
    minimal: prevBound === null || prevBound > targetError,
    bytes,
    float32Bytes: p.length * 4,
    ratio: bytes / (p.length * 4),
  };
}

export function quantizeAndCertify(input, bits, opts = {}) {
  const enc = quantizePositions(input, bits, opts);
  const check = certify(input, enc);
  return { enc, check };
}
