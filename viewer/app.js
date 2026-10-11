import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const els = {
  viewport: document.getElementById('viewport'),
  list: document.getElementById('list'),
  count: document.getElementById('count'),
  dir: document.getElementById('dir'),
  name: document.getElementById('model-name'),
  meta: document.getElementById('model-meta'),
  loading: document.getElementById('loading'),
  empty: document.getElementById('empty'),
  toast: document.getElementById('toast'),
  weight: document.getElementById('model-weight'),
  weightText: document.getElementById('weight-text'),
  material: document.getElementById('material'),
};

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
els.viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 20000);
camera.position.set(160, 160, 160);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.09;

const hemi = new THREE.HemisphereLight(0xffffff, 0x444c5e, 1.0);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffffff, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
scene.add(key, key.target);

const fill = new THREE.DirectionalLight(0xbcd0ff, 0.9);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.8);
scene.add(rim);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.ShadowMaterial({ opacity: 0.3 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02;
ground.receiveShadow = true;
scene.add(ground);

const material = new THREE.MeshStandardMaterial({
  color: 0xb3bdcc,
  metalness: 0.08,
  roughness: 0.55,
});

let mesh = null;
let grid = null;
let gridOn = true;
let models = [];
let currentIndex = -1;
let loadToken = 0;
let fitDist = 200;
const targetCenter = new THREE.Vector3();
let tween = null;
let currentVolume = 0;

const VIEWS = {
  iso: [1, 0.8, 1],
  top: [0, 1, 0.0001],
  front: [0, 0.0001, 1],
  side: [1, 0.0001, 0],
};

function fmt(v) {
  return v.toFixed(1);
}

function fmtBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function computeVolume(geometry) {
  const pos = geometry.attributes.position.array;
  let volume = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i];
    const ay = pos[i + 1];
    const az = pos[i + 2];
    const bx = pos[i + 3];
    const by = pos[i + 4];
    const bz = pos[i + 5];
    const cx = pos[i + 6];
    const cy = pos[i + 7];
    const cz = pos[i + 8];
    volume +=
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);
  }
  return Math.abs(volume) / 6;
}

function updateWeight() {
  if (!(currentVolume > 0)) {
    els.weight.hidden = true;
    return;
  }
  const cm3 = currentVolume / 1000;
  const grams = cm3 * Number(els.material.value);
  els.weightText.textContent = `${cm3.toFixed(1)} cm³ · ≈ ${grams.toFixed(1)} g (solid)`;
  els.weight.hidden = false;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 5000);
}

function buildGrid(size) {
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  const extent = Math.max(size.x, size.z, 40) * 2.4;
  const length = Math.ceil(extent / 20) * 20;
  grid = new THREE.GridHelper(length, Math.round(length / 10), 0x49536b, 0x262d40);
  grid.visible = gridOn;
  scene.add(grid);
  ground.scale.set(length * 5, length * 5, 1);
}

function setActive(index) {
  currentIndex = index;
  for (const button of els.list.children) {
    button.classList.toggle('active', Number(button.dataset.index) === index);
  }
}

async function select(index) {
  if (index < 0 || index >= models.length || index === currentIndex) return;
  const entry = models[index];
  const token = ++loadToken;
  tween = null;
  setActive(index);
  els.loading.hidden = false;
  try {
    const res = await fetch(`/models/${encodeURIComponent(entry.name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    if (token !== loadToken) return;
    const geometry = new STLLoader().parse(buffer);
    if (token !== loadToken) return;
    showModel(entry, geometry);
    document.title = `${entry.name} — STL Viewer`;
  } catch (err) {
    if (token === loadToken) showToast(`Failed to load ${entry.name}: ${err.message}`);
  } finally {
    if (token === loadToken) els.loading.hidden = true;
  }
}

function showModel(entry, geometry) {
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
  }

  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -box.min.y, -center.z);
  geometry.computeBoundingSphere();

  mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  fitDist = geometry.boundingSphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.12;
  targetCenter.set(0, size.y / 2, 0);

  const footprint = Math.max(size.x, size.z);
  buildGrid(size);

  const r = footprint * 0.8 + size.y + 20;
  key.position.set(r * 0.9, r * 1.7, r * 0.8);
  key.target.position.copy(targetCenter);
  key.shadow.camera.left = -r;
  key.shadow.camera.right = r;
  key.shadow.camera.top = r;
  key.shadow.camera.bottom = -r;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = r * 10;
  key.shadow.camera.updateProjectionMatrix();
  fill.position.set(-r * 1.3, r * 1.1, -r);
  rim.position.set(-r * 0.4, r * 0.6, -r * 1.4);

  const triangles = geometry.attributes.position.count / 3;
  currentVolume = computeVolume(geometry);
  updateWeight();
  els.name.textContent = entry.name.replace(/\.stl$/i, '');
  els.meta.textContent =
    `${fmt(size.x)} × ${fmt(size.z)} × ${fmt(size.y)} mm  ·  ${triangles.toLocaleString()} triangles`;

  setView('iso', 0);
}

function setView(name, duration = 380) {
  const dir = new THREE.Vector3(...VIEWS[name]).normalize();
  const to = targetCenter.clone().addScaledVector(dir, fitDist);
  if (duration > 0) {
    tween = {
      fromPos: camera.position.clone(),
      toPos: to,
      fromTarget: controls.target.clone(),
      toTarget: targetCenter.clone(),
      start: performance.now(),
      duration,
    };
  } else {
    tween = null;
    camera.position.copy(to);
    controls.target.copy(targetCenter);
    controls.update();
  }
}

function modelButton(entry, index) {
  const button = document.createElement('button');
  button.className = 'model';
  button.dataset.index = index;
  button.title = entry.name;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = entry.name.replace(/\.stl$/i, '').replace(/[_-]+/g, ' ');
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = fmtBytes(entry.size);
  button.append(label, size);
  button.addEventListener('click', () => select(index));
  return button;
}

async function init() {
  resize();
  let data;
  try {
    data = await (await fetch('/api/models')).json();
  } catch {
    els.count.textContent = 'offline';
    els.empty.hidden = false;
    els.empty.textContent = 'Could not reach the viewer server';
    showToast('Failed to load the model list. Is the server running?');
    return;
  }
  models = data.models;
  els.dir.textContent = data.dir;
  els.count.textContent = models.length === 1 ? '1 model' : `${models.length} models`;
  els.empty.hidden = models.length > 0;
  els.list.replaceChildren(...models.map(modelButton));
  if (models.length) select(0);
}

function resize() {
  const width = els.viewport.clientWidth || window.innerWidth;
  const height = els.viewport.clientHeight || window.innerHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b === button));
    setView(button.dataset.view);
  });
});

els.material.addEventListener('change', updateWeight);

document.getElementById('wire').addEventListener('click', (event) => {
  material.wireframe = !material.wireframe;
  event.currentTarget.classList.toggle('active', material.wireframe);
});

document.getElementById('grid').addEventListener('click', (event) => {
  gridOn = !gridOn;
  if (grid) grid.visible = gridOn;
  ground.visible = gridOn;
  event.currentTarget.classList.toggle('active', gridOn);
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  if (!models.length) return;
  event.preventDefault();
  const step = event.key === 'ArrowDown' ? 1 : -1;
  select((currentIndex + step + models.length) % models.length);
});

window.addEventListener('resize', resize);

renderer.setAnimationLoop(() => {
  if (tween) {
    const t = Math.min(1, (performance.now() - tween.start) / tween.duration);
    const eased = t * t * (3 - 2 * t);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, eased);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    if (t >= 1) tween = null;
  }
  controls.update();
  renderer.render(scene, camera);
});

init();
