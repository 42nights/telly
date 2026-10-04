#!/usr/bin/env python3
"""Telly AR pin simulation: save -> relocalize -> project, over randomized trials.

Session 1 scans a rendered room, triangulates an ORB feature map from VIO poses (with drift), pins the
medicine box with a raycast against that map, and saves map + anchor in the shape of the app's
`ar.pinSaved` bridge reply. Session 2 starts from another pose, in other light, with something in the
way; it decodes the `ar.findPin` request, relocalizes with ORB matching + PnP + RANSAC, follows its own
VIO to the frame that looks at the box, and projects the anchor there.

ARKit is not simulated: this proves the pipeline and its limits, not Apple's tracker.

    python tools/ar-sim/run.py              # 50 baseline trials + 20 per failure case; exit 1 below the bar
    python tools/ar-sim/run.py --quick      # CI: 30 baseline + 4 per failure case, same gate
"""

import argparse
import base64
import io
import json
import os
import sys
import time
import zlib
from multiprocessing import Pool

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R

CONTAINER_ID = "box-1"
MIN_INLIERS = 50
AGREE_M = 0.05  # two relocalization fixes agree when they put the anchor within 5 cm of each other
PASS = {"reloc_rate": 0.90, "err_cm": 5.0, "err_px": 20.0}
BASE = {
    "span": 120, "scan_frames": 24, "plain": False,  # session 1: arc in degrees around the box
    "light": (0.6, 1.4), "gradient": 0.4, "tint": 0.1,  # session 2 lighting relative to session 1
    "find_frames": 12, "find_r": (1.0, 2.6),  # session 2 start distance from the box, metres
}
CASES = {
    "baseline": {},
    "short-scan": {"span": 8, "scan_frames": 4},
    "featureless-walls": {"plain": True},
    "big-lighting-change": {"light": (0.05, 0.1), "gradient": 0.8, "tint": 0.4},
    "far-start": {"find_r": (3.0, 4.0)},  # start across the room (the far wall is about 3.9 m away)
}


def look_at(eye, target):
    z = target - eye
    z /= np.linalg.norm(z)
    x = np.cross(z, (0.0, 0.0, 1.0))
    x /= np.linalg.norm(x)
    T = np.eye(4)
    T[:3, :3] = np.column_stack([x, np.cross(z, x), z])
    T[:3, 3] = eye
    return T


def in_room(p):
    return np.clip(p, (0.6, 0.3, 0.9), (4.2, 3.7, 1.9))


def vio(rng, true_poses):
    """VIO estimate in session coordinates (origin = first frame). Assumed drift, typical of phone VIO:
    a random walk of 1 percent of the distance walked and 0.05 degrees per frame."""
    origin, drift, out = np.linalg.inv(true_poses[0]), np.eye(4), []
    for i, T in enumerate(true_poses):
        if i:
            step = np.eye(4)
            step[:3, :3] = cv2.Rodrigues(rng.normal(0, np.radians(0.05), 3))[0]
            step[:3, 3] = rng.normal(0, 0.01 * np.linalg.norm(T[:3, 3] - true_poses[i - 1][:3, 3]) + 1e-4, 3)
            drift = step @ drift
        out.append(drift @ origin @ T)
    return out


def scan_path(rng, pin, span, n):
    """Session 1: walk an arc in front of the box, looking around it; the middle frame aims at the box."""
    phi0, r, h = np.pi + rng.uniform(-0.3, 0.3), rng.uniform(1.3, 2.2), rng.uniform(1.2, 1.6)
    poses = []
    for k in range(n):
        phi = phi0 + np.radians(span) * (k / max(n - 1, 1) - 0.5)
        eye = in_room(pin + (r * np.cos(phi), r * np.sin(phi), h - pin[2] + rng.normal(0, 0.03)))
        target = pin + (rng.normal(0, (0.1, 0.5, 0.3)) if k != n // 2 else 0)
        poses.append(look_at(eye, target))
    return poses


def find_path(rng, pin, n, r_range):
    """Session 2: start elsewhere, looking elsewhere, and turn toward the box while walking a little."""
    phi, r, h = np.pi + rng.uniform(-1.0, 1.0), rng.uniform(*r_range), rng.uniform(1.0, 1.7)
    start = in_room(pin + (r * np.cos(phi), r * np.sin(phi), h - pin[2]))
    walk, look0 = rng.normal(0, (0.3, 0.3, 0.05)), pin + rng.normal(0, (0.3, 0.9, 0.4))
    look1 = pin + rng.normal(0, 0.05, 3)
    return [look_at(in_room(start + s * walk), (1 - s) * look0 + s * look1) for s in np.linspace(0, 1, n)]


def features(orb, img):
    kp, des = orb.detectAndCompute(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), None)
    return np.float32([k.pt for k in kp]).reshape(-1, 2), des


def to_cam(T_wc, X):
    T = np.linalg.inv(T_wc)
    return X @ T[:3, :3].T + T[:3, 3]


def project(Xc):
    p = Xc @ R.K.T
    return p[:, :2] / p[:, 2:]


def build_map(feats, poses, bf):
    """Triangulate matched ORB features between nearby frames; keep well-conditioned points."""
    pts, descs = [], []
    P = [R.K @ np.linalg.inv(T)[:3] for T in poses]
    for i in range(len(feats)):
        for j in range(i + 2, min(i + 5, len(feats))):
            (pi, di), (pj, dj) = feats[i], feats[j]
            if di is None or dj is None:
                continue
            m = [x for x in bf.match(di, dj) if x.distance < 50]
            if len(m) < 8:
                continue
            a, b = pi[[x.queryIdx for x in m]], pj[[x.trainIdx for x in m]]
            X = cv2.triangulatePoints(P[i], P[j], a.T, b.T)
            X = (X[:3] / X[3]).T
            ok = np.ones(len(X), bool)
            for T, uv in ((poses[i], a), (poses[j], b)):
                Xc = to_cam(T, X)
                ok &= Xc[:, 2] > 0.2
                ok &= np.linalg.norm(project(Xc) - uv, axis=1) < 2.0
            ri, rj = X - poses[i][:3, 3], X - poses[j][:3, 3]
            cos = (ri * rj).sum(1) / (np.linalg.norm(ri, axis=1) * np.linalg.norm(rj, axis=1))
            ok &= cos < np.cos(np.radians(6.0))  # parallax: about 1 percent depth error per pixel of noise
            pts.append(X[ok])
            descs.append(di[[x.queryIdx for x in m]][ok])
    if not pts:
        return np.zeros((0, 3), np.float32), np.zeros((0, 32), np.uint8)
    pts, descs = np.concatenate(pts).astype(np.float32), np.concatenate(descs)
    _, keep = np.unique(np.round(pts / 0.01), axis=0, return_index=True)  # one point per 1 cm cell
    return pts[keep], descs[keep]


def raycast(T_wc, tap_px, pts):
    """Hit test against the feature map: median depth of map points around the tap (ARKit-style)."""
    Xc = to_cam(T_wc, pts)
    front = Xc[:, 2] > 0.2
    near = front.copy()
    near[front] = np.linalg.norm(project(Xc[front]) - tap_px, axis=1) < 20
    if near.sum() < 3:
        return None
    ray = np.linalg.inv(R.K) @ (*tap_px, 1.0)
    hit = ray * np.median(Xc[near, 2])
    return T_wc[:3, :3] @ hit + T_wc[:3, 3]


def save_pin(pts, des, anchor):
    """The app's `ar.pinSaved` reply: worldMap is base64 of a zlib-compressed archive with the anchor."""
    T = np.eye(4)
    T[:3, 3] = anchor
    buf = io.BytesIO()
    np.savez(buf, points=pts, descriptors=des, anchor_name=f"telly-pin-{CONTAINER_ID}", anchor_transform=T)
    blob = zlib.compress(buf.getvalue(), 6)
    return {
        "type": "ar.pinSaved", "requestId": "sim", "containerId": CONTAINER_ID,
        "anchorId": f"telly-pin-{CONTAINER_ID}", "worldMap": base64.b64encode(blob).decode(), "mapBytes": len(blob),
    }


def load_pin(request):
    """Native side of `ar.findPin`: decode the world map and find the named anchor in it."""
    m = np.load(io.BytesIO(zlib.decompress(base64.b64decode(request["worldMap"]))))
    assert str(m["anchor_name"]) == request["anchorId"]
    return m["points"], m["descriptors"], m["anchor_transform"][:3, 3]


def relocalize(orb, bf, img, pts, des):
    """Camera pose in map coordinates from ORB matches + PnP + RANSAC, or None."""
    p, d = features(orb, img)
    m = [x for x in bf.match(d, des) if x.distance < 50] if d is not None else []
    if len(m) < MIN_INLIERS:
        return None
    obj = pts[[x.trainIdx for x in m]].astype(np.float64)
    uv = p[[x.queryIdx for x in m]].astype(np.float64)
    ok, rvec, tvec, inl = cv2.solvePnPRansac(obj, uv, R.K, None, iterationsCount=500, reprojectionError=3.0, confidence=0.999)
    if not ok or inl is None or len(inl) < MIN_INLIERS:
        return None
    inl = inl[:, 0]
    rvec, tvec = cv2.solvePnPRefineLM(obj[inl], uv[inl], R.K, None, rvec, tvec)
    T_cm = np.eye(4)
    T_cm[:3, :3], T_cm[:3, 3] = cv2.Rodrigues(rvec)[0], tvec[:, 0]
    return np.linalg.inv(T_cm)


def trial(job):
    case, seed, evidence_dir = job
    cv2.setNumThreads(1)
    cfg = {**BASE, **CASES[case]}
    rng = np.random.default_rng(seed)
    orb, bf = cv2.ORB_create(nfeatures=2000), cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    faces, pin = R.make_scene(rng, cfg["plain"])
    res = {"case": case, "seed": seed, "saved": False, "relocalized": False}

    # Session 1: scan, map, pin, save.
    true1 = scan_path(rng, pin, cfg["span"], cfg["scan_frames"])
    est1 = vio(rng, true1)
    feats = [features(orb, R.capture(R.render(faces, T), rng, light=rng.uniform(0.9, 1.1), gradient=0.1, blur_px=rng.uniform(0, 4))) for T in true1]
    pts, des = build_map(feats, est1, bf)
    t = len(true1) // 2
    tap_px = project(to_cam(true1[t], pin[None]))[0]
    anchor = raycast(est1[t], tap_px, pts) if len(pts) else None
    res["map_points"] = len(pts)
    if anchor is None:
        return res  # the app would answer mapping-not-ready
    saved = json.loads(json.dumps(save_pin(pts, des, anchor)))  # through the bridge as JSON
    res.update(saved=True, map_bytes=saved["mapBytes"])

    # Session 2: new origin, light, occluder; relocalize, then follow VIO to the last frame and project.
    request = {"type": "ar.findPin", "requestId": "sim", "containerId": CONTAINER_ID, "label": "Pills",
               "anchorId": saved["anchorId"], "worldMap": saved["worldMap"]}
    mpts, mdes, manchor = load_pin(request)
    true2 = find_path(rng, pin, cfg["find_frames"], cfg["find_r"])
    est2 = vio(rng, true2)
    light, tint = rng.uniform(*cfg["light"]), 1 + rng.uniform(-cfg["tint"], cfg["tint"], 3)
    # ARKit keeps matching the map while it tracks. A single PnP fix on distant, near-planar points can
    # be confidently wrong, so relocalization counts only once two fixes agree on where the anchor is.
    fixes, first = [], None  # the anchor in session-2 coordinates, one per frame that matched the map
    for k, T in enumerate(true2):
        img = R.capture(R.render(faces, T), rng, light, cfg["gradient"], tint, rng.uniform(0, 6), occluder=True)
        T_mc = relocalize(orb, bf, img, mpts, mdes)
        if T_mc is not None:
            fixes.append(to_cam(T_mc @ np.linalg.inv(est2[k]), manchor[None])[0])
            if first is None and sum(np.linalg.norm(f - fixes[-1]) < AGREE_M for f in fixes) >= 2:
                first = k
    res["fixes"] = len(fixes)
    if first is None:
        return res
    F = np.array(fixes)
    agree = np.linalg.norm(F[:, None] - F[None], axis=2) < AGREE_M
    anchor2 = F[agree[agree.sum(1).argmax()]].mean(0)
    est_c, true_c = to_cam(est2[-1], anchor2[None]), to_cam(true2[-1], pin[None])
    est_px, true_px = project(est_c)[0], project(true_c)[0]
    res.update(relocalized=True, reloc_frame=first, err_cm=100 * float(np.linalg.norm(est_c - true_c)),
               err_px=float(np.linalg.norm(est_px - true_px)))
    if evidence_dir and seed < 3:  # same pose and light, without the occluder, so the box is visible
        draw = R.capture(R.render(faces, true2[-1]), np.random.default_rng(seed), light, cfg["gradient"], tint)
        cv2.drawMarker(draw, tuple(int(v) for v in true_px), (0, 0, 255), cv2.MARKER_CROSS, 40, 2)
        cv2.circle(draw, tuple(int(v) for v in est_px), 14, (0, 255, 0), 3)
        cv2.putText(draw, f"{case}: {res['err_cm']:.1f} cm, {res['err_px']:.1f} px (green=pin, red=truth)",
                    (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        cv2.imwrite(os.path.join(evidence_dir, f"{case}-{seed}.jpg"), draw, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return res


def summarize(rows):
    ok = [r for r in rows if r["relocalized"]]
    cm, px = np.array([r["err_cm"] for r in ok]), np.array([r["err_px"] for r in ok])
    pct = lambda a, q: float(np.percentile(a, q)) if len(a) else float("nan")
    return {
        "trials": len(rows), "saved": sum(r["saved"] for r in rows), "reloc_rate": len(ok) / len(rows),
        "err_cm_median": pct(cm, 50), "err_cm_p95": pct(cm, 95), "err_cm_max": pct(cm, 100),
        "err_px_median": pct(px, 50), "err_px_p95": pct(px, 95), "err_px_max": pct(px, 100),
        "within_bar": sum(r["err_cm"] <= PASS["err_cm"] and r["err_px"] <= PASS["err_px"] for r in ok) / len(rows),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trials", type=int, default=50, help="baseline trials (default 50)")
    ap.add_argument("--failure-trials", type=int, default=20, help="trials per failure case (default 20)")
    ap.add_argument("--quick", action="store_true", help="CI size: 30 baseline, 4 per failure case")
    ap.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    a = ap.parse_args()
    if a.quick:
        a.trials, a.failure_trials = 30, 4
    os.makedirs(a.out, exist_ok=True)
    jobs = [("baseline", s, a.out) for s in range(a.trials)]
    jobs += [(c, s, a.out) for c in CASES if c != "baseline" for s in range(a.failure_trials)]
    t0 = time.time()
    with Pool(a.workers) as pool:
        rows = pool.map(trial, jobs, chunksize=1)
    summary = {c: summarize([r for r in rows if r["case"] == c]) for c in CASES}
    lines = ["| case | trials | map saved | relocalized | 3D error cm (median / p95 / max) | screen error px (median / p95 / max) | within 5 cm and 20 px |",
             "|---|---|---|---|---|---|---|"]
    for c, s in summary.items():
        lines.append(f"| {c} | {s['trials']} | {s['saved'] / s['trials']:.0%} | {s['reloc_rate']:.0%}"
                     f" | {s['err_cm_median']:.2f} / {s['err_cm_p95']:.2f} / {s['err_cm_max']:.2f}"
                     f" | {s['err_px_median']:.1f} / {s['err_px_p95']:.1f} / {s['err_px_max']:.1f} | {s['within_bar']:.0%} |")
    b = summary["baseline"]
    passed = b["reloc_rate"] >= PASS["reloc_rate"] and b["err_cm_p95"] <= PASS["err_cm"] and b["err_px_p95"] <= PASS["err_px"]
    table = "\n".join(lines)
    print(table)
    print(f"\nbaseline gate (reloc >= 90%, p95 <= 5 cm and <= 20 px): {'PASS' if passed else 'FAIL'}  ({time.time() - t0:.0f} s)")
    with open(os.path.join(a.out, "results.json"), "w") as f:
        json.dump({"pass": passed, "summary": summary, "trials": rows}, f, indent=1)
    with open(os.path.join(a.out, "results.md"), "w") as f:
        f.write(table + "\n")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
