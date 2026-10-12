// Lightweight-model generator for the Lily58 case STLs.
//
//   base: punches through-openings into the 2 mm floor, keeping an 8 mm solid
//         border along all walls/features plus a 6 mm rib grid (28 mm pitch)
//   lid:  blind pockets (2.0 -> 1.2 mm) into the hidden inner face only
//
// Usage:
//   cd tools && npm install
//   node gen-lite.mjs [srcDir] [outDir]     defaults: ../stls and ../stls-lite
//
// Tuning knobs: PARAMS below (margin / ribPitch / ribWidth / cutZ).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Module from 'manifold-3d';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] ?? path.resolve(HERE, '..', 'stls');
const OUT = process.argv[3] ?? path.resolve(HERE, '..', 'stls-lite');

const wasm = await Module();
wasm.setup();
const T = wasm.Manifold;

const STEP = 0.75;
const PARAMS = {
  base: { name: 'base', margin: 8, ribPitch: 28, ribWidth: 6, cutZ: [-1, 3.0] },
  lid: { name: 'lid', margin: 8, ribPitch: 0, ribWidth: 0, cutZ: [1.2, 3.0] },
};

function parseSTL(file) {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(80);
  const xyz = new Float32Array(n * 9);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    for (let j = 0; j < 9; j++) {
      const v = b.readFloatLE(o + 12 + j * 4);
      xyz[i * 9 + j] = v;
      if (v < min[j % 3]) min[j % 3] = v;
      if (v > max[j % 3]) max[j % 3] = v;
    }
  }
  return { xyz, n, min, max, size: min.map((m, i) => max[i] - m) };
}

function indexMesh(xyz, n) {
  const map = new Map();
  const vertProperties = [];
  let next = 0;
  const key = (i) => `${Math.round(xyz[i] * 1000)},${Math.round(xyz[i + 1] * 1000)},${Math.round(xyz[i + 2] * 1000)}`;
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    for (let k = 0; k < 3; k++) {
      const j = o + k * 3;
      if (!map.has(key(j))) {
        map.set(key(j), next++);
        vertProperties.push(xyz[j], xyz[j + 1], xyz[j + 2]);
      }
    }
  }
  const tris = [];
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const idx = [];
    for (let k = 0; k < 3; k++) {
      const j = o + k * 3;
      idx.push(map.get(key(j)));
    }
    if (idx[0] === idx[1] || idx[1] === idx[2] || idx[0] === idx[2]) continue;
    tris.push(idx[0], idx[1], idx[2]);
  }
  return {
    numProp: 3,
    vertProperties: new Float32Array(vertProperties),
    triVerts: Uint32Array.from(tris),
  };
}

function toManifold(model) {
  const m = T.ofMesh(indexMesh(model.xyz, model.n));
  return m;
}

function raycastColumns(model) {
  const { xyz, n, min, size } = model;
  const nx = Math.floor(size[0] / STEP);
  const ny = Math.floor(size[1] / STEP);
  // bucket triangles by 1mm y-rows for speed
  const rows = Math.ceil(size[1] / 1.0) + 2;
  const buckets = Array.from({ length: rows }, () => []);
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const y1 = xyz[o + 1], y2 = xyz[o + 4], y3 = xyz[o + 7];
    const ylo = Math.min(y1, y2, y3), yhi = Math.max(y1, y2, y3);
    for (let r = Math.floor((ylo - min[1]) / 1.0); r <= Math.floor((yhi - min[1]) / 1.0); r++) {
      if (r >= 0 && r < rows) buckets[r].push(i);
    }
  }
  const EPX = 0.371, EPY = 0.293;
  const firstEnd = new Float32Array(nx * ny).fill(NaN);
  const nextStart = new Float32Array(nx * ny).fill(Infinity);
  const hits = [];
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      const px = min[0] + (ix + 0.5) * STEP + EPX;
      const py = min[1] + (iy + 0.5) * STEP + EPY;
      const row = Math.floor((py - min[1]) / 1.0);
      const list = buckets[row];
      hits.length = 0;
      for (const i of list) {
        const o = i * 9;
        const ax = xyz[o], ay = xyz[o + 1], az = xyz[o + 2];
        const bx = xyz[o + 3], by = xyz[o + 4], bz = xyz[o + 5];
        const cx = xyz[o + 6], cy = xyz[o + 7], cz = xyz[o + 8];
        const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
        const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
        const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
        if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-9) continue;
        const w1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const w2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        hits.push(w1 * az + w2 * bz + (1 - w1 - w2) * cz);
      }
      if (!hits.length) continue;
      hits.sort((a, b) => a - b);
      if (hits.length % 2 !== 0) continue;
      const i = ix * ny + iy;
      firstEnd[i] = hits[1];
      if (hits.length > 2) nextStart[i] = hits[2];
    }
  }
  return { nx, ny, firstEnd, nextStart };
}

function chamferDistance(blocked, nx, ny) {
  const INF = 1e9;
  const d = new Float32Array(nx * ny);
  for (let i = 0; i < d.length; i++) d[i] = blocked[i] ? 0 : INF;
  const at = (ix, iy) => (ix < 0 || iy < 0 || ix >= nx || iy >= ny ? 0 : d[ix * ny + iy]);
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
    const i = ix * ny + iy;
    if (d[i] === 0) continue;
    d[i] = Math.min(d[i], at(ix - 1, iy) + 1, at(ix, iy - 1) + 1, at(ix - 1, iy - 1) + 1.414, at(ix - 1, iy + 1) + 1.414);
  }
  for (let ix = nx - 1; ix >= 0; ix--) for (let iy = ny - 1; iy >= 0; iy--) {
    const i = ix * ny + iy;
    if (d[i] === 0) continue;
    d[i] = Math.min(d[i], at(ix + 1, iy) + 1, at(ix, iy + 1) + 1, at(ix + 1, iy + 1) + 1.414, at(ix + 1, iy - 1) + 1.414);
  }
  return d;
}

function punchMask(cols, model, params) {
  const { nx, ny, firstEnd, nextStart } = cols;
  const { min } = model;
  const clean = new Uint8Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    const fe = firstEnd[i];
    if (Number.isNaN(fe)) continue;
    if (fe <= 2.4 && (nextStart[i] === Infinity || nextStart[i] >= 3.2)) clean[i] = 1;
  }
  const notClean = new Uint8Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) notClean[i] = clean[i] ? 0 : 1;
  const dist = chamferDistance(notClean, nx, ny);
  const marginCells = params.margin / STEP;
  const open = new Uint8Array(nx * ny);
  let openArea = 0;
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      const i = ix * ny + iy;
      if (!clean[i] || dist[i] <= marginCells) continue;
      if (params.ribPitch) {
        const ux = min[0] + (ix + 0.5) * STEP;
        const uy = min[1] + (iy + 0.5) * STEP;
        const rx = (((ux - min[0]) % params.ribPitch) + params.ribPitch) % params.ribPitch;
        const ry = (((uy - min[1]) % params.ribPitch) + params.ribPitch) % params.ribPitch;
        if (rx < params.ribWidth || ry < params.ribWidth) continue;
      }
      open[i] = 1;
      openArea += STEP * STEP;
    }
  }
  return { open, openArea };
}

function maskToRects(open, nx, ny, min) {
  const rects = [];
  let prev = new Map();
  for (let iy = 0; iy < ny; iy++) {
    const cur = new Map();
    let ix = 0;
    while (ix < nx) {
      if (!open[ix * ny + iy]) { ix++; continue; }
      const start = ix;
      while (ix < nx && open[ix * ny + iy]) ix++;
      const key = `${start}:${ix - 1}`;
      cur.set(key, prev.has(key) ? prev.get(key) : { x0: start, x1: ix - 1, y0: iy });
    }
    for (const [key, r] of prev) {
      if (!cur.has(key)) rects.push({ ...r, y1: iy - 1 });
    }
    prev = cur;
  }
  for (const r of prev.values()) rects.push({ ...r, y1: ny - 1 });
  return rects.map((r) => ({
    x0: min[0] + r.x0 * STEP,
    x1: min[0] + (r.x1 + 1) * STEP,
    y0: min[1] + r.y0 * STEP,
    y1: min[1] + (r.y1 + 1) * STEP,
  }));
}

function rectsToBoxes(rects, z0, z1) {
  const h = z1 - z0;
  return rects.map((r) =>
    T.cube([r.x1 - r.x0, r.y1 - r.y0, h], true).translate([(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (z0 + z1) / 2])
  );
}

function batchUnion(items) {
  if (typeof T.union === 'function') {
    try { return T.union(items); } catch { /* fall through */ }
  }
  const step = 256;
  let level = items;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += step) {
      const chunk = level.slice(i, i + step);
      next.push(chunk.reduce((a, b) => a.add(b)));
    }
    level = next;
  }
  return level[0];
}

function processPart(model, params) {
  const m = toManifold(model);
  const before = m.volume();
  const cols = raycastColumns(model);
  const { open, openArea } = punchMask(cols, model, params);
  const rects = maskToRects(open, cols.nx, cols.ny, model.min);
  const [z0, z1] = params.cutZ;
  const cut = batchUnion(rectsToBoxes(rects, z0, z1));
  if (process.env.DEBUG) {
    const cb = cut.boundingBox();
    console.log(`  debug: cut solid volume ${(cut.volume() / 1000).toFixed(1)} cm³, bbox ${cb.min.map((v) => v.toFixed(1))} .. ${cb.max.map((v) => v.toFixed(1))}`);
  }
  const lite = m.subtract(cut);
  const after = lite.volume();
  return { lite, before, after, openArea, holes: rects.length, expected: openArea * (params.name === 'lid' ? 0.8 : 2.0) };
}

function writeSTL(mesh, file, header) {
  const { vertProperties, triVerts } = mesh;
  const nTri = triVerts.length / 3;
  const buf = Buffer.alloc(84 + nTri * 50);
  buf.write(header.slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(nTri, 80);
  let o = 84;
  for (let i = 0; i < nTri; i++) {
    const a = triVerts[i * 3] * 3, b = triVerts[i * 3 + 1] * 3, c = triVerts[i * 3 + 2] * 3;
    const ax = vertProperties[a], ay = vertProperties[a + 1], az = vertProperties[a + 2];
    const bx = vertProperties[b], by = vertProperties[b + 1], bz = vertProperties[b + 2];
    const cx = vertProperties[c], cy = vertProperties[c + 1], cz = vertProperties[c + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8);
    buf.writeFloatLE(ax, o + 12); buf.writeFloatLE(ay, o + 16); buf.writeFloatLE(az, o + 20);
    buf.writeFloatLE(bx, o + 24); buf.writeFloatLE(by, o + 28); buf.writeFloatLE(bz, o + 32);
    buf.writeFloatLE(cx, o + 36); buf.writeFloatLE(cy, o + 40); buf.writeFloatLE(cz, o + 44);
    o += 50;
  }
  fs.writeFileSync(file, buf);
}

function mirrorProcessed(mesh) {
  const vertProperties = Float32Array.from(mesh.vertProperties);
  for (let i = 0; i < vertProperties.length; i += 3) vertProperties[i] = -vertProperties[i];
  const triVerts = Uint32Array.from(mesh.triVerts);
  for (let i = 0; i < triVerts.length; i += 3) {
    const tmp = triVerts[i + 1];
    triVerts[i + 1] = triVerts[i + 2];
    triVerts[i + 2] = tmp;
  }
  return { numProp: 3, vertProperties, triVerts };
}

function vertexSet(xyz, n, mirrorX = false) {
  const set = new Set();
  for (let i = 0; i < n * 9; i += 3) {
    const x = mirrorX ? -xyz[i] : xyz[i];
    set.add(`${Math.round(x * 200)},${Math.round(xyz[i + 1] * 200)},${Math.round(xyz[i + 2] * 200)}`);
  }
  return set;
}

function mirrorCheck(left, right) {
  const a = vertexSet(left.xyz, left.n, true);
  const b = vertexSet(right.xyz, right.n, false);
  let common = 0;
  for (const k of a) if (b.has(k)) common++;
  return { matchA: common / a.size, matchB: common / b.size };
}

const files = fs.readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.stl'));
const leftBase = files.find((f) => /left.*base/i.test(f));
const leftLid = files.find((f) => /left.*lid/i.test(f));
const rightBase = files.find((f) => /right.*base/i.test(f));
const rightLid = files.find((f) => /right.*lid/i.test(f));

fs.mkdirSync(OUT, { recursive: true });

for (const [leftName, rightName, kind] of [
  [leftBase, rightBase, 'base'],
  [leftLid, rightLid, 'lid'],
]) {
  const left = parseSTL(path.join(SRC, leftName));
  const right = parseSTL(path.join(SRC, rightName));
  const mirror = mirrorCheck(left, right);
  console.log(`\n[${kind}] mirror check left vs right: coverage ${(mirror.matchA * 100).toFixed(2)}% / ${(mirror.matchB * 100).toFixed(2)}%`);
  const isMirror = mirror.matchA > 0.999 && mirror.matchB > 0.999;

  const params = PARAMS[kind];
  const { lite, before, after, openArea, holes, expected } = processPart(left, params);
  console.log(`[${kind}] volume: ${(before / 1000).toFixed(1)} -> ${(after / 1000).toFixed(1)} cm³ (removed ${((before - after) / 1000).toFixed(1)}, expected ~${(expected / 1000).toFixed(1)})`);
  console.log(`[${kind}] punched holes: ${holes} rects, open area ${(openArea / 100).toFixed(0)} cm² of ~${(left.size[0] * left.size[1] / 100).toFixed(0)} cm² bbox`);
  const liteMesh = lite.getMesh();
  writeSTL(liteMesh, path.join(OUT, leftName), `lite ${leftName}`);

  if (isMirror) {
    writeSTL(mirrorProcessed(liteMesh), path.join(OUT, rightName), `lite ${rightName} (mirror)`);
    console.log(`[${kind}] right part written as exact mirror`);
  } else {
    const { lite: liteR } = processPart(right, params);
    writeSTL(liteR.getMesh(), path.join(OUT, rightName), `lite ${rightName}`);
    console.log(`[${kind}] right part processed independently`);
  }
}
console.log('\ndone');
