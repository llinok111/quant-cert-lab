// Renderer + interaction only. All numeric work is delegated to src/core.mjs
// (the same module bench/verify.mjs calls in node).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  computeBounds, quantizePositions, dequantizePositions, measureError, chooseBits,
} from './src/core.mjs';
import { sharedBounds, quantizeShared, bruteError } from './baseline/naive.mjs';

const $ = (id) => document.getElementById(id);
const app = $('app');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 500);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x223044, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 2.6);
key.position.set(3, 5, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0x7aa2ff, 1.4);
rim.position.set(-4, -2, -3);
scene.add(rim);

const material = new THREE.MeshStandardMaterial({
  vertexColors: true, metalness: 0.15, roughness: 0.55, flatShading: false,
});
const wireMaterial = new THREE.MeshBasicMaterial({
  color: 0x4a5b73, wireframe: true, transparent: true, opacity: 0.28,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});

let meshes = [];
let sharedBox = null;
let current = -1;
let bits = 12;
let solid = null;
let wire = null;

const palette = [
  new THREE.Color(0x2b6cb0),
  new THREE.Color(0x63b3ed),
  new THREE.Color(0xf6e05e),
  new THREE.Color(0xf56565),
];

function samplePalette(t) {
  const x = Math.min(0.999, Math.max(0, t)) * (palette.length - 1);
  const i = Math.floor(x);
  return palette[i].clone().lerp(palette[Math.min(palette.length - 1, i + 1)], x - i);
}

function fitCamera(pos, bounds) {
  const center = new THREE.Vector3(...bounds.center);
  const radius = Math.max(0.35, bounds.diagonal * 0.5);
  camera.position.set(center.x + radius * 2.1, center.y + radius * 1.5, center.z + radius * 2.1);
  camera.near = Math.max(1e-6, radius / 500);
  camera.far = radius * 200;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function rebuild(index) {
  const m = meshes[index];
  const original = Float32Array.from(m.positions);
  const bounds = computeBounds(original);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(original, 3));
  geometry.setIndex(m.indices);
  geometry.computeVertexNormals();

  if (solid) { scene.remove(solid); solid.geometry.dispose(); }
  if (wire) { scene.remove(wire); wire.geometry.dispose(); }

  solid = new THREE.Mesh(geometry, material);
  wire = new THREE.Mesh(geometry, wireMaterial);
  solid.renderOrder = 1;
  wire.renderOrder = 0;
  scene.add(solid, wire);

  m.original = original;
  m.bounds = bounds;
  m.geometry = geometry;
  fitCamera(original, bounds);
  applyBits(bits);
}

function applyBits(newBits) {
  if (current < 0) return;
  bits = newBits;
  const m = meshes[current];
  const original = m.original;
  const bounds = m.bounds;
  const enc = quantizePositions(original, bits, { bounds });
  const decoded = dequantizePositions(enc);
  const err = measureError(original, decoded);
  const bound = enc.declared.boundWithUnit;

  const attr = m.geometry.getAttribute('position');
  attr.array.set(decoded);
  attr.needsUpdate = true;
  const count = original.length / 3;
  const colors = new Float32Array(count * 3);
  let above = 0;
  for (let i = 0; i < count; i += 1) {
    const e = Math.hypot(
      original[i * 3] - decoded[i * 3],
      original[i * 3 + 1] - decoded[i * 3 + 1],
      original[i * 3 + 2] - decoded[i * 3 + 2],
    );
    if (e > bound) above += 1;
    const c = samplePalette(bound > 0 ? e / bound : 0);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  m.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  m.geometry.computeVertexNormals();
  m.geometry.computeBoundingSphere();

  // Independent comparison: one shared bbox for the whole scene (baseline module).
  const sharedDecoded = quantizeShared(original, sharedBox, bits);
  const sharedErr = bruteError(original, sharedDecoded);

  const pick = chooseBits(original, bounds.diagonal / 1e4, { bounds });
  const float32Bytes = original.length * 4;

  $('s-mesh').textContent = meshes[current].name;
  $('s-count').textContent = `${count} / ${m.indices.length / 3}`;
  $('s-bits').textContent = String(bits);
  $('s-bound').textContent = bound.toExponential(3);
  $('s-max').textContent = `${err.max.toExponential(3)}`;
  $('s-tight').textContent = `${(err.max / bound).toFixed(3)}${above === 0 ? ' ✓' : ` ✗ ${above} above`}`;
  $('s-tight').className = above === 0 ? 'v ok' : 'v warn';
  $('s-bytes').textContent = `${enc.bytes} B / ${float32Bytes} B`;
  $('s-save').textContent = `${((1 - enc.bytes / float32Bytes) * 100).toFixed(2)}%`;
  const ratio = sharedErr.max / bound;
  $('s-base').textContent = `${sharedErr.max.toExponential(3)} (${ratio.toFixed(2)}× bound)`;
  $('s-base').className = ratio > 1 ? 'v warn' : 'v';
  $('s-pick').textContent = `${pick.bits} bits`;
  $('s-bitslider').textContent = String(bits);
  window.__lastRun = { bits, bound, measuredMax: err.max, bytes: enc.bytes, sharedMax: sharedErr.max, above };
}

function buildMeshButtons() {
  const host = $('meshes');
  host.innerHTML = '';
  meshes.forEach((m, i) => {
    const b = document.createElement('button');
    b.textContent = m.name;
    b.onclick = () => {
      current = i;
      for (const child of host.children) child.classList.remove('on');
      b.classList.add('on');
      rebuild(i);
    };
    host.appendChild(b);
  });
}

$('bits').addEventListener('input', (e) => {
  applyBits(Number(e.target.value));
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

fetch('./data/meshes.json')
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then((doc) => {
    meshes = doc.meshes;
    sharedBox = sharedBounds(meshes.map((m) => ({ positions: Float32Array.from(m.positions) })));
    buildMeshButtons();
    current = 0;
    $('meshes').children[0].classList.add('on');
    rebuild(0);
  })
  .catch((err) => {
    $('s-mesh').textContent = `load failed: ${err.message}`;
  });
