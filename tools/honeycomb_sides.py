"""Honeycomb the big side-wall windows of the Lily58 lap base STLs.

Replaces the large rectangular windows in the side walls with a proper
honeycomb (pointy-top hex) pattern: fills each zone with a wall patch that
FOLLOWS the true wall surface r(azimuth, z) (the walls are coned/flared in
places), then boolean-cuts a fitted hex lattice with uniform webs and margins.
Small functional slots are left untouched. Works directly on the STL
(trimesh + manifold3d), at the model's native mm scale.

Usage:
  python honeycomb_sides.py <input.stl> [output.stl]

Tunables in PARAMS. Set HC_DEBUG=<dir> to export intermediate pieces + frames.
"""
import argparse
import os

import numpy as np
import trimesh
from scipy import ndimage

PARAMS = {
    "step_az_deg": 0.5,
    "step_z": 1.0,
    "big_min_arc": 11.0,       # openings wider than this (mm arc) are honeycombed
    "small_keep": 10.0,        # openings narrower than this stay untouched
    "merge_span": 20.0,        # merge big openings whose gap (mm) is at most this
    "margin_levels": [4.5, 3.0, 2.2],
    "web": 4.5,                # material web between hexes (uniform by lattice)
    "r_min": 5.0,
    "r_max": 9.5,
    "patch_thick": 2.8,        # fill patch thickness (wall is ~2.3)
    "patch_recess": 0.12,      # sink patch below wall surface to hide the seam
    "patch_overlap_z": 3.0,
    "cut_out": 1.5,            # cut this far outside the wall surface
    "cut_in": 4.5,             # ... and this far inside
    "patch_levels": 7,         # z stations across the patch (follows cones/flares)
}


# ---------------------------------------------------------------- scanning
def scan_wall(mesh, P):
    (x0, y0, z0), (x1, y1, z1) = mesh.bounds
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    step_az = np.radians(P["step_az_deg"])
    azs = np.arange(0, 2 * np.pi, step_az)
    zs = np.arange(z0 + 0.25, z1, P["step_z"])
    dirs2 = np.column_stack([np.cos(azs), np.sin(azs)])
    Rmax = 0.5 * np.hypot(x1 - x0, y1 - y0) + 30
    origins = np.repeat(dirs2, len(zs), axis=0) * Rmax + [cx, cy]
    origins = np.column_stack([origins, np.tile(zs, len(azs))])
    dirs = np.repeat(-dirs2, len(zs), axis=0)
    dirs = np.column_stack([dirs, np.zeros(len(dirs))])
    res = mesh.ray.intersects_location(origins, dirs, multiple_hits=True)
    locs, rid = res[0], res[1]
    na, nz = len(azs), len(zs)
    d0 = np.full((na, nz), np.nan)
    order = np.lexsort((((locs - origins[rid]) * dirs[rid]).sum(1), rid))
    first = {}
    for k in order:
        first.setdefault(rid[k], k)
    for r, k in first.items():
        ai, zi = divmod(r, nz)
        d0[ai, zi] = ((locs[k] - origins[r]) * dirs[r]).sum()
    dmin = np.nanmin(d0, axis=1)
    wall = np.isfinite(d0) & ((d0 - dmin[:, None]) <= 15.0)
    return dict(azs=azs, zs=zs, d0=d0, wall=wall, dmin=dmin,
                center=np.array([cx, cy]), Rmax=Rmax, bounds=mesh.bounds)


def wall_surface(scan):
    """Return (rtab, rfun). rfun(az_deg, z) follows the true wall radius with
    its cones/flares and interpolates linearly across openings gaps."""
    azs, zs, wall, d0, Rmax = scan["azs"], scan["zs"], scan["wall"], scan["d0"], scan["Rmax"]
    na, nz = len(azs), len(zs)
    rgrid = np.full((na, nz), np.nan)
    rtab = np.full(na, np.nan)
    for i in range(na):
        zc = zs[wall[i]]
        rc = Rmax - d0[i, wall[i]]
        if len(rc) >= 3:
            rtab[i] = np.median(rc)
        if len(zc) >= 2:
            rgrid[i] = np.interp(zs, zc, rc)
        elif len(zc) == 1:
            rgrid[i] = rc[0]
    good = np.isfinite(rtab)
    rtab = np.interp(np.arange(na), np.where(good)[0], rtab[good], period=na)
    for i in range(na):
        if np.isnan(rgrid[i]).all():
            rgrid[i] = rtab[i]
    for j in range(nz):
        col = rgrid[:, j]
        g = np.isfinite(col)
        if not g.all():
            col[~g] = np.interp(np.arange(na)[~g], np.where(g)[0], col[g], period=na)
    azdeg = azs * 180 / np.pi

    def rfun(az_deg, z):
        j = min(max(int(np.searchsorted(zs, z)) - 1, 0), len(zs) - 2)
        t = (z - zs[j]) / (zs[j + 1] - zs[j])
        rs = rgrid[:, j] * (1 - t) + rgrid[:, j + 1] * t
        return float(np.interp(az_deg % 360, azdeg, rs, period=360))

    return rtab, rfun


# ------------------------------------------------------------ mesh builders
def strip_solid(rings):
    """rings: (K, P, 3) station x closed-profile x xyz -> watertight solid with caps."""
    K, P_ = rings.shape[0], rings.shape[1]
    c0 = rings[0].mean(axis=0)
    c1 = rings[-1].mean(axis=0)
    verts = np.vstack([rings.reshape(-1, 3), c0[None], c1[None]])
    i0, i1 = K * P_, K * P_ + 1
    faces = []
    for k in range(K - 1):
        for c in range(P_):
            c2 = (c + 1) % P_
            a, b = k * P_ + c, k * P_ + c2
            d, e = (k + 1) * P_ + c, (k + 1) * P_ + c2
            faces.append([a, d, e])
            faces.append([a, e, b])
    for c in range(P_):
        faces.append([i0, (c + 1) % P_, c])
        faces.append([i1, (K - 1) * P_ + c, (K - 1) * P_ + (c + 1) % P_])
    m = trimesh.Trimesh(vertices=verts, faces=np.array(faces, dtype=np.int64), process=True)
    m.fix_normals()
    return m


def _prism_from_polygon(poly, lo, hi):
    n = len(poly)
    verts = np.vstack([poly + lo, poly + hi])
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, j, n + j])
        faces.append([i, n + j, n + i])
    for i in range(1, n - 1):
        faces.append([0, i + 1, i])
        faces.append([n, n + i, n + i + 1])
    m = trimesh.Trimesh(vertices=verts, faces=np.array(faces, dtype=np.int64), process=True)
    m.fix_normals()
    return m


# ---------------------------------------------------------------- main edit
def process(path, out_path, P=PARAMS, log=print):
    mesh = trimesh.load(path)
    assert mesh.is_watertight
    scan = scan_wall(mesh, P)
    rtab, rfun = wall_surface(scan)
    azs, zs, wall = scan["azs"], scan["zs"], scan["wall"]
    cx, cy = scan["center"]

    def wall_point(a_deg, r_off=0.0, z=None):
        a = np.radians(a_deg % 360)
        r = (rfun(a_deg, z) if z is not None
             else np.interp(a_deg % 360, azs * 180 / np.pi, rtab, period=360)) + r_off
        return np.array([cx + r * np.cos(a), cy + r * np.sin(a)])

    def wall_frame(a_deg, z):
        p = wall_point(a_deg, 0.0, z)
        p2 = wall_point(a_deg + 0.5, 0.0, z)
        t = p2 - p
        t /= np.linalg.norm(t)
        nrm = np.array([t[1], -t[0]])
        if np.dot(nrm, p - np.array([cx, cy])) < 0:
            nrm = -nrm
        return p, t, nrm

    # --- openings ---
    open_ = ~wall
    lab, n = ndimage.label(open_)
    openings = []
    for k in range(1, n + 1):
        ai, zi = np.where(lab == k)
        if len(ai) < 4:
            continue
        az0, az1 = np.degrees(azs[ai.min()]), np.degrees(azs[ai.max()])
        rm = rtab[ai].mean()
        openings.append(dict(az0=az0, az1=az1, zlo=zs[zi.min()], zhi=zs[zi.max()],
                             arc=np.radians(az1 - az0) * rm))
    big = [o for o in openings if o["arc"] >= P["big_min_arc"] and o["zhi"] - o["zlo"] > 8]
    small = [o for o in openings if o not in big]
    log(f"[{os.path.basename(path)}] openings: {len(openings)} total, {len(big)} big, {len(small)} small")

    # merge close big openings into zones (wrap-around aware)
    big.sort(key=lambda o: o["az0"])
    ext = [(o["az0"], o["az1"], o) for o in big] + [(o["az0"] + 360, o["az1"] + 360, o) for o in big]
    merged = []
    for az0, az1, o in ext:
        if merged and (az0 - merged[-1]["az1"]) * rtab.mean() * np.pi / 180 <= P["merge_span"]:
            merged[-1]["az1"] = max(merged[-1]["az1"], az1)
            merged[-1]["zlo"] = min(merged[-1]["zlo"], o["zlo"])
            merged[-1]["zhi"] = max(merged[-1]["zhi"], o["zhi"])
        else:
            merged.append(dict(az0=az0, az1=az1, zlo=o["zlo"], zhi=o["zhi"]))
    zones = []
    for z in merged:
        if z["az0"] >= 360:
            continue
        z = dict(z)
        w = z["az1"] - z["az0"]
        z["az0"] %= 360
        z["az1"] = z["az0"] + w
        zones.append(z)

    def contains(a, b):
        k = round((b["az0"] - a["az0"]) / 360)
        return b["az0"] - 1e-6 <= a["az0"] + 360 * k and a["az1"] + 360 * k <= b["az1"] + 1e-6

    zones = [a for a in zones if not any(a is not b and contains(a, b) for b in zones)]
    log(f"  zones after merge: {len(zones)}")
    for z in zones:
        log(f"    zone az {z['az0']:.1f}..{z['az1']:.1f}  z {z['zlo']:.1f}..{z['zhi']:.1f}")

    patches, hexes = [], []
    zone_report = []
    for z in zones:
        a0, a1 = z["az0"], z["az1"]
        zc = (z["zlo"] + z["zhi"]) / 2
        Uh = z["zhi"] - z["zlo"]
        m = int(round((a1 - a0) / P["step_az_deg"])) + 1
        aaz = np.linspace(a0, a1, m)
        rloc = np.array([rfun(a, zc) for a in aaz])       # arc at the cells' height
        pts = np.column_stack([cx + rloc * np.cos(np.radians(aaz)),
                               cy + rloc * np.sin(np.radians(aaz))])
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        arc_tot = float(seg.sum())

        fit = None
        for margin in P["margin_levels"]:
            Uw = arc_tot - 2 * margin
            Uhh = Uh - 2 * margin
            if min(P["r_max"], Uhh / 2, Uw / np.sqrt(3)) < P["r_min"]:
                continue
            best = None
            R = P["r_max"]
            while R >= P["r_min"] - 1e-9:
                a = np.sqrt(3) * R + P["web"]
                cells = [(i * a + j * a / 2, j * a * np.sqrt(3) / 2)
                         for i in range(-6, 7) for j in range(-6, 7)
                         if abs(i * a + j * a / 2) <= Uw / 2 - np.sqrt(3) * R / 2 + 1e-6
                         and abs(j * a * np.sqrt(3) / 2) <= Uhh / 2 - R + 1e-6]
                if cells:
                    score = len(cells) * R ** 2
                    if best is None or score > best[0] + 1e-6 or (
                            abs(score - best[0]) < 1e-6 and R > best[1]):
                        best = (score, R, cells)
                R -= 0.25
            if best:
                fit = dict(margin=margin, R=best[1], cells=best[2])
                break
        if fit is None:
            log(f"  zone az {a0:.1f}..{a1:.1f}: no hex fit, skipped")
            continue

        # fill patch following r(az, z)
        zlo2 = max(z["zlo"] - P["patch_overlap_z"], float(zs[0]))
        zhi2 = min(z["zhi"] + P["patch_overlap_z"], float(zs[-1]))
        levels = np.linspace(zlo2, zhi2, P["patch_levels"])
        rings = []
        for a_deg in np.linspace(a0 - 1.5, a1 + 1.5, m + 8):
            outer = [np.append(wall_point(a_deg, -P["patch_recess"], zz), zz) for zz in levels]
            inner = [np.append(wall_point(a_deg, -(P["patch_recess"] + P["patch_thick"]), zz), zz)
                     for zz in levels[::-1]]
            rings.append(np.array(outer + inner))
        patches.append(strip_solid(np.array(rings)))

        # hex cells placed on the true surface at their own z
        cum = np.concatenate([[0], np.cumsum(seg)])
        made = 0
        for xpos, zpos in fit["cells"]:
            a_deg = float(np.interp(arc_tot / 2 + xpos, cum, aaz))
            ze = zc + zpos
            p, t, nrm = wall_frame(a_deg, ze)
            if os.environ.get("HC_DEBUG"):
                log(f"    cell xpos={xpos:6.1f} az={a_deg:7.2f} z={ze:4.1f} "
                    f"p=({p[0]:6.1f},{p[1]:6.1f}) n=({nrm[0]:5.2f},{nrm[1]:5.2f})")
            e1 = np.array([t[0], t[1], 0.0])
            ez = np.array([0.0, 0.0, 1.0])
            n3 = np.array([nrm[0], nrm[1], 0.0])
            R = fit["R"]
            p3 = np.array([p[0], p[1], ze])
            poly = np.tile(p3, (6, 1))
            poly = poly + np.outer(R * np.cos(np.radians(np.arange(30, 390, 60))), e1) \
                        + np.outer(R * np.sin(np.radians(np.arange(30, 390, 60))), ez)
            hexes.append(_prism_from_polygon(poly, -n3 * P["cut_in"], n3 * P["cut_out"]))
            made += 1
        zone_report.append((a0, a1, z["zlo"], z["zhi"], fit["margin"], fit["R"], made))
        log(f"  zone az {a0:.1f}..{a1:.1f}: margin {fit['margin']}mm, hex R {fit['R']}mm, cells {made}")

    if not hexes:
        log("no hexes were placed; aborting")
        return None

    if os.environ.get("HC_DEBUG"):
        dbg = os.environ["HC_DEBUG"]
        os.makedirs(dbg, exist_ok=True)
        for i, hx in enumerate(hexes):
            hx.export(os.path.join(dbg, f"hex_{i:02d}.stl"))
        for i, pa in enumerate(patches):
            pa.export(os.path.join(dbg, f"patch_{i:02d}.stl"))
        log(f"  debug pieces written to {dbg} ({len(hexes)} hexes, {len(patches)} patches)")

    log("union patches ...")
    for i, pa in enumerate(patches):
        if not (pa.is_watertight and pa.is_winding_consistent and pa.volume > 0):
            log(f"  patch {i} BAD: watertight={pa.is_watertight} "
                f"winding={pa.is_winding_consistent} vol={pa.volume:.1f}mm3 "
                f"euler={pa.euler_number} faces={len(pa.faces)}")
            pa.update_faces(pa.nondegenerate_faces())
            pa.update_faces(pa.unique_faces())
            pa.merge_vertices()
            pa.remove_unreferenced_vertices()
            pa.fix_normals()
            if not pa.is_watertight:
                trimesh.repair.fill_holes(pa)
            log(f"  patch {i} after repair: watertight={pa.is_watertight} vol={pa.volume:.1f}mm3")
    with_patches = trimesh.boolean.union([mesh] + patches, engine="manifold")
    log("cut honeycomb ...")
    try:
        hex_u = trimesh.boolean.union(hexes, engine="manifold")
        result = trimesh.boolean.difference([with_patches, hex_u], engine="manifold")
    except Exception as e:
        log(f"  batch boolean failed ({e}); falling back to sequential cuts")
        result = with_patches
        for hx in hexes:
            result = trimesh.boolean.difference([result, hx], engine="manifold")

    result.export(out_path)
    log(f"  volume: {mesh.volume/1000:.2f} -> {result.volume/1000:.2f} cm3  "
        f"({(mesh.volume - result.volume)/1000:+.2f} cm3 net)")
    log(f"  watertight={result.is_watertight} bodies={result.body_count}")

    # ---- verification: rescan result ----
    v = trimesh.load(out_path)
    scan2 = scan_wall(v, P)
    open2 = ~scan2["wall"]
    lab2, n2 = ndimage.label(open2)
    rep2 = []
    for k in range(1, n2 + 1):
        ai, zi = np.where(lab2 == k)
        if len(ai) < 4:
            continue
        rep2.append((np.degrees(scan2["azs"][ai.min()]), np.degrees(scan2["azs"][ai.max()]),
                     scan2["zs"][zi.min()], scan2["zs"][zi.max()]))

    def shift(az, ref):
        return az + 360 if az < ref - 180 else az

    log("  --- result openings inside original zones ---")
    for a0, a1, zl, zh, margin, R, made in zone_report:
        within = sorted((shift(o[0], a0), shift(o[1], a0)) for o in rep2
                        if a0 - 4 <= shift(o[0], a0) and shift(o[1], a0) <= a1 + 4)
        widths = [np.radians(t1 - t0) * np.interp((t0 + t1) / 2 % 360,
                                                  azs * 180 / np.pi, rtab, period=360)
                  for t0, t1 in within]
        gaps = [np.radians(within[i + 1][0] - within[i][1]) *
                np.interp(within[i][1] % 360, azs * 180 / np.pi, rtab, period=360)
                for i in range(len(within) - 1)]
        log(f"    zone az {a0:.1f}..{a1:.1f}: {len(within)} hex openings, "
            f"widths {[round(w, 1) for w in widths]}, webs {[round(g, 1) for g in gaps] if gaps else '-'}")
    for o in small:
        if any(shift(o["az0"], zz["az0"]) < zz["az1"] and zz["az0"] < shift(o["az1"], zz["az0"])
               for zz in zones):
            log(f"    small slot az {o['az0']:.1f}..{o['az1']:.1f} [{o['arc']:.1f}mm] inside zone (absorbed)")
            continue
        ok = any(min(shift(x[1], o["az0"]), o["az1"]) - max(shift(x[0], o["az0"]), o["az0"])
                 >= 0.6 * (o["az1"] - o["az0"])
                 and not (x[3] < o["zlo"] - 4 or x[2] > o["zhi"] + 4) for x in rep2)
        log(f"    small slot az {o['az0']:.1f}..{o['az1']:.1f} [{o['arc']:.1f}mm] still open: {ok}")
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output", nargs="?", default=None)
    args = ap.parse_args()
    out = args.output or args.input.replace(".stl", "_honeycomb.stl")
    process(args.input, out)
