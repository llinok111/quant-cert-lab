# quant-cert-lab

**Declare the error bound first, then compress inside it.** Six sample primitives (6,064 vertices, 72,768 B of float32 positions) are bit-packed to **27,438 B at 12 bits — 62.29% smaller — with 0/6,064 vertices outside the declared bound (worst case 97.4% of it)**, and the same code solves the inverse problem: given a target error ε = diagonal/1e4 it picks **13 bits, and proves 12 bits cannot work** (12-bit bound 4.741e-4 > target 3.882e-4 on the torus). Baseline (`baseline/naive.mjs`): one shared bbox for the whole scene, which breaks the *same* per-primitive bound on **559/6,064 vertices, worst 1.85×**.

Upstream: none

## 本轮创新

**A priori, falsifiable compression certificate + minimal-depth proof.** The bound is derived from `bounds × bits` *before* any data is quantized — `sqrt(Σ (size_a / (2·(2^b−1)))²) + maxAbs·2⁻²⁴` (the last term covers float32 decode storage) — and the repo then checks it against measurements rather than the other way round. Three things make this more than a wrapper:

1. **The solver proves optimality, not just feasibility**: `chooseBits` returns the smallest depth whose *a-priori* bound meets ε and also returns the depth−1 bound, so "13 bits" is accompanied by "12 bits gives 4.741e-4 > 3.882e-4". Verified 12/12.
2. **A competing strategy falsifies the same bound**: shared-bbox quantization (the obvious approach) exceeds the per-primitive certificate on 559/6,064 vertices. The certificate is therefore not vacuous — it discriminates between two real strategies.
3. **Browser = node, same module**: the viewer runs `src/core.mjs` on a slider and prints declared bound / measured max / tightness / packed bytes live, with per-vertex colour = error ÷ bound, so the certificate can be inspected per vertex rather than trusted as a summary number.

Ledger check (2026-11-01 … 11-12, last 20 entries): prior 3D entries are *decision* certificates (convexity, clearance, maximality) or *constructive repair* (clearance-repair, camera smoothing). None is a compression error certificate with a minimal-depth optimality proof and a falsifying baseline. This is B 档 (new evidence dimension, every number reproducible with one command), not a re-skin.

## 怎么跑

Requires Node ≥ 20 (measured on v24.19.0). No dependencies, no install step.

```bash
node tools/gen-sample.mjs && node bench/verify.mjs     # regenerate data + all assertions
node bench/bench.mjs                                   # timings -> bench/result.json
python3 -m http.server 4173                             # viewer at http://localhost:4173
```

`verify.mjs` exits 0 only if every assertion passes; `bench.mjs` rewrites `bench/result.json`. The generator is seeded (`SEED=20261113`), and `verify.mjs` re-runs it and compares SHA-256 to prove byte-identical output.

## 证据（全部来自本次运行）

Corpus: 6 parametric primitives — torus, sphere, cylinder, terrain patch, helix tube, bracket — 6,064 vertices, float32 payload 72,768 B. Header cost 25 B/primitive (6 float32 bounds + 1 byte depth) is counted in every packed size.

| bits | packed total | vs float32 | corpus max error | declared bound | vertices outside bound |
|---|---|---|---|---|---|
| 8  | 18,342 B | −74.79% | 7.545e-3 | 7.612e-3 | 0 / 6,064 |
| 10 | 22,891 B | −68.54% | 1.833e-3 | 1.897e-3 | 0 / 6,064 |
| 12 | 27,438 B | −62.29% | 4.618e-4 | 4.741e-4 | 0 / 6,064 |
| 16 | 36,534 B | −49.79% | 2.892e-5 | 2.970e-5 | 0 / 6,064 |

24 mesh×depth combinations: tightness (measured ÷ bound) spans **0.769 … 0.991**, i.e. the bound is never exceeded and stays within 23% of the true maximum.

`node bench/verify.mjs` → **111 passed, 0 failed** (each line prints its measured value):

- certificate: 24/24 combinations `violations=0`, `measuredMax ≤ bound`.
- independent oracle (`baseline/naive.mjs`, its own distance loop): worst absolute delta over 24 combinations **2.17e-19**.
- minimal depth: **12/12** targets met, each with `minimal=true` and the depth−1 bound printed above the target.
- scale invariance: **30/30** (6 meshes × 1e-6, 1e-3, 1, 1e3, 1e6) keep the identical bit depth and stay certified under the scaled target.
- bit packing: 16 depths × 500 values = 8,000 values, 0 mismatches.
- generator determinism: SHA-256 prefix identical before/after a re-run.
- shared-bbox baseline at 8 bits: **559/6,064** vertices above the per-primitive bound, worst **1.85×**.

Timing, per corpus of 6 primitives, warmup 1 + 9 samples × 200 repetitions (min/median/p95/stddev/RSD in `bench/result.json`; the minimal-depth solve uses 2,000 repetitions per sample because it is ~0.07 ms):

| operation | median | p95 | RSD |
|---|---|---|---|
| encode 12-bit + bit-pack | 1.262 ms | 1.343 ms | 2.23% |
| decode + error measurement | 0.664 ms | 0.671 ms | 0.88% |
| certify (re-quantize + check) | 1.925 ms | 2.005 ms | 1.47% |
| minimal-depth solve | 0.068 ms | 0.072 ms | 1.94% |
| baseline shared-bbox + oracle error | 0.279 ms | 0.307 ms | 3.42% |

Cold start (first encode in a fresh process): **10.799 ms**. All RSDs are below 10%, so no variance caveat is needed for these rows.

## 核心 API（`src/core.mjs`，纯计算，无 three / DOM / I/O）

- `computeBounds(positions)` → min / max / size / diagonal / maxAbs.
- `declaredError(bounds, bits)` → the certificate: per-axis half-step, euclidean bound, float32 allowance, final `bound`.
- `quantizePositions(positions, bits, {bounds})` → bit-packed little-endian payload + header + certificate.
- `dequantizePositions(enc)` → Float32Array (what a real decoder would produce).
- `measureError(original, decoded)`, `certify(original, enc)` → measured max / RMS / tightness / violations.
- `chooseBits(positions, targetError)` → minimal depth + the depth−1 bound that refutes it.

## 已知限制

- **Per-vertex positional error only.** The bound covers vertices; triangle interiors may deviate by up to the bound in the worst case. There is no surface-Hausdorff proof — a triangle's interior error is bounded by the max of its three vertices only for linear interpolation of the *decoded* coordinates, which is what the viewer shows, but this is not a mesh-approximation guarantee.
- **Absolute bound, but it is the mesh's own bound.** `bound = sqrt(Σ (size_a/(2·maxQ))²) + maxAbs·2⁻²⁴` scales with the primitive's bbox, so the same bit depth gives a proportionally scaled error (validated 1e-6 … 1e6). It is not a unit-free threshold. The float32 term is proportional to `maxAbs`, so a mesh translated far from the origin pays a larger allowance.
- **The payload is not a glTF extension.** It is a private bit-packed layout (3 components × `bits`, LSB-first); it does not implement KHR_mesh_quantization, Draco, meshopt, normals or UVs. Only positions are quantized.
- **No entropy coding.** The ratio is fixed by depth (0.377 at 12 bits, 0.252 at 8 bits including headers); a general-purpose compressor on top was not attempted.
- **One depth for the whole primitive** (uniform per axis). Per-axis or per-cluster bit allocation would do better on anisotropic meshes; the solver returns a single integer.
- **Viewer verification is static.** `python3 -m http.server 4173` returns 200 and the import map resolves to a pinned three@0.169.0 on jsDelivr; headless browsers are forbidden in this environment, so there is no GPU pixel comparison and no screenshot in the repo. The page's numbers come from the same `src/core.mjs` used by `bench/verify.mjs`; `window.__lastRun` exposes the last computed row for manual inspection.
- **Timings are single-threaded** on a 4-core / 3.6 GB machine with Node v24.19.0; they are throughput numbers for this corpus, not a claim about large assets.

## License

MIT — see `LICENSE`. Sample geometry is generated by `tools/gen-sample.mjs`; no third-party asset is included. The renderer imports three.js r169 from jsDelivr at runtime (MIT), not vendored.
