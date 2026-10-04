#!/usr/bin/env python3
"""Telly AR pin simulation: save -> relocalize -> project, over randomized trials.

Session 1 scans a rendered room, triangulates an ORB feature map from VIO poses (with drift), pins the
medicine box with a raycast against that map, and saves map + anchor in the shape of the app's
`ar.pinSaved` bridge reply. Session 2 starts from another pose, in other light, with something in the
way; it decodes the `ar.findPin` request, relocalizes with ORB matching + PnP + RANSAC, follows its own
VIO to the frame that looks at the box, and projects the anchor there.

ARKit is not simulated: this proves the pipeline and its limits, not Apple's tracker.

    python tools/ar-sim/run.py              # 50 baseline trials + 20 per failure case; exit 1 below the bar
    python tools/ar-sim/run.py --quick      # CI: 24 baseline trials only, same gate
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
MIN_SPREAD_PX = 50  # inliers in a thin strip (one shelf edge, one line of text) let PnP rotate about it
PAIR_STEP_DEG = 15  # pairing mode: a slow turn on the spot, about 0.5 s per frame at 30 degrees per second
PAIR_MAX = 48  # two full turns; pairing that has not completed by then keeps asking (the trial stops counting)
GUIDE_FRAMES = 10  # frames after pairing, following the arrow to the marker
PASS = {"paired": 0.95, "reloc_rate": 0.90, "err_cm": 5.0, "err_px": 20.0, "arrow_deg": 15.0}  # arrow: view-ray error to the box
BASE = {
    "span": 120, "scan_frames": 24, "plain": False,  # session 1: arc in degrees around the box
    "light": (0.6, 1.4), "gradient": 0.4, "tint": 0.1,  # session 2 lighting relative to session 1
    "find_r": (1.0, 2.6),  # session 2 start distance from the box, metres
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


def vio_step(rng, drift, T_prev, T):
    """One VIO update. Assumed drift, typical of phone VIO: a random walk of 1 percent of the distance
    walked and 0.05 degrees per frame. The estimate in session coordinates is drift @ inv(T0) @ T."""
    step = np.eye(4)
    step[:3, :3] = cv2.Rodrigues(rng.normal(0, np.radians(0.05), 3))[0]
    step[:3, 3] = rng.normal(0, 0.01 * np.linalg.norm(T[:3, 3] - T_prev[:3, 3]) + 1e-4, 3)
    return step @ drift


def vio(rng, true_poses):
    """VIO estimates in session coordinates (origin = first frame) for a fixed path."""
    origin, drift, out = np.linalg.inv(true_poses[0]), np.eye(4), []
    for i, T in enumerate(true_poses):
        if i:
            drift = vio_step(rng, drift, true_poses[i - 1], T)
        out.append(drift @ origin @ T)
    return out


def scan_path(rng, pin, span, n, phi=np.pi):
    """Session 1: walk an arc in front of the box, looking around it; the middle frame aims at the box.
    `phi` is the side of the box the arc is on (pi: the -x side, toward the room from the cabinet)."""
    phi0, r, h = phi + rng.uniform(-0.3, 0.3), rng.uniform(1.3, 2.2), rng.uniform(1.2, 1.6)
    poses = []
    for k in range(n):
        phi = phi0 + np.radians(span) * (k / max(n - 1, 1) - 0.5)
        eye = in_room(pin + (r * np.cos(phi), r * np.sin(phi), h - pin[2] + rng.normal(0, 0.03)))
        target = pin + (rng.normal(0, (0.1, 0.5, 0.3)) if k != n // 2 else 0)
        poses.append(look_at(eye, target))
    return poses


def pairing_pose(eye, k, yaw0):
    """Pairing mode: the person turns slowly on the spot (15 degrees per frame), tilting the phone up and down."""
    yaw, pitch = yaw0 + np.radians(PAIR_STEP_DEG) * k, np.radians(-15 + 10 * np.sin(0.7 * k))
    return look_at(eye, eye + (np.cos(yaw) * np.cos(pitch), np.sin(yaw) * np.cos(pitch), np.sin(pitch)))


def walk_closer(eye, remembered):
    """Pairing after one full turn without a match: "Walk closer to where you pinned the medicine and look
    around." The person walks 30 cm per frame toward the spot they remember, stopping about 1.2 m short."""
    d = (remembered - eye)[:2]
    if np.linalg.norm(d) <= 1.2:
        return eye
    return in_room(eye + 0.3 * np.append(d / np.linalg.norm(d), 0))


def guided_pose(T, goal):
    """The person follows the app's arrow: turn toward the app's guess (at most 30 degrees of yaw and 15 of
    pitch per frame) and walk 15 cm toward it until about 1.2 m away."""
    eye, d = T[:3, 3].copy(), T[:3, 2]
    to_goal = goal - eye
    if np.linalg.norm(to_goal[:2]) > 1.2:
        eye = in_room(eye + 0.15 * np.append(to_goal[:2] / np.linalg.norm(to_goal[:2]), 0))
    want = goal - eye
    yaw0, pitch0 = np.arctan2(d[1], d[0]), np.arcsin(np.clip(d[2], -1, 1))
    yaw1, pitch1 = np.arctan2(want[1], want[0]), np.arctan2(want[2], np.linalg.norm(want[:2]))
    yaw = yaw0 + np.clip((yaw1 - yaw0 + np.pi) % (2 * np.pi) - np.pi, -np.radians(30), np.radians(30))
    pitch = pitch0 + np.clip(pitch1 - pitch0, -np.radians(15), np.radians(15))
    return look_at(eye, eye + (np.cos(yaw) * np.cos(pitch), np.sin(yaw) * np.cos(pitch), np.sin(pitch)))


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


def relocalize(bf, feat, pts, des):
    """Camera pose in map coordinates from ORB matches (feat: the frame's `features`) + PnP + RANSAC, or None."""
    p, d = feat
    m = [x for x in bf.match(d, des) if x.distance < 50] if d is not None else []
    if len(m) < MIN_INLIERS:
        return None
    obj = pts[[x.trainIdx for x in m]].astype(np.float64)
    uv = p[[x.queryIdx for x in m]].astype(np.float64)
    ok, rvec, tvec, inl = cv2.solvePnPRansac(obj, uv, R.K, None, iterationsCount=500, reprojectionError=3.0, confidence=0.999)
    if not ok or inl is None or len(inl) < MIN_INLIERS:
        return None
    inl = inl[:, 0]
    if np.sqrt(np.linalg.eigvalsh(np.cov(uv[inl].T))[0]) < MIN_SPREAD_PX:  # smallest principal spread
        return None
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

    # Session 2: new origin, light, occluder. The person only does what the app shows them, so the path
    # depends on the app's own estimates:
    #   "P" pairing mode: no fix yet. "Turn slowly and look around the room" until the first fix; this
    #       must complete, because before it the app has no idea where the box is.
    #   "A" arrow: at least one fix. The person turns and walks toward the app's best guess.
    #   "M" marker: two fixes agree within AGREE_M (one PnP fix on distant, near-planar points can be
    #       confidently wrong) and the guess is on screen.
    request = {"type": "ar.findPin", "requestId": "sim", "containerId": CONTAINER_ID, "label": "Pills",
               "anchorId": saved["anchorId"], "worldMap": saved["worldMap"]}
    mpts, mdes, manchor = load_pin(request)
    phi, r = np.pi + rng.uniform(-1.0, 1.0), rng.uniform(*cfg["find_r"])
    eye = in_room(pin + (r * np.cos(phi), r * np.sin(phi), rng.uniform(1.0, 1.7) - pin[2]))
    yaw0 = rng.uniform(0, 2 * np.pi)  # facing any direction, not necessarily toward the box
    light, tint = rng.uniform(*cfg["light"]), 1 + rng.uniform(-cfg["tint"], cfg["tint"], 3)
    remembered = pin + np.append(rng.normal(0, 0.5, 2), 0)  # where the person thinks they pinned it
    T = pairing_pose(eye, 0, yaw0)
    origin, drift = np.linalg.inv(T), np.eye(4)
    true2, fixes, first, paired, stages, arrow_err, arrow_k = [], [], None, None, "", [], None
    while True:
        k, est = len(true2), drift @ origin @ T
        true2.append(T)
        img = R.capture(R.render(faces, T), rng, light, cfg["gradient"], tint, rng.uniform(0, 6), occluder=True)
        T_mc = relocalize(bf, features(orb, img), mpts, mdes)
        if T_mc is not None:
            fixes.append(to_cam(T_mc @ np.linalg.inv(est), manchor[None])[0])
            paired = k if paired is None else paired
            if first is None and sum(np.linalg.norm(f - fixes[-1]) < AGREE_M for f in fixes) >= 2:
                first = k
        if not fixes:
            stages += "P"
            if k + 1 >= PAIR_MAX:
                break
            if k + 1 >= 360 // PAIR_STEP_DEG:
                eye = walk_closer(eye, remembered)
            T_next = pairing_pose(eye, k + 1, yaw0)
        else:
            guess = best_guess(fixes)
            est_c, true_c = to_cam(est, guess[None])[0], to_cam(T, pin[None])[0]
            if first is not None and on_screen(est_c):
                stages += "M"
            else:
                stages += "A"
                arrow_err.append(ray_angle_deg(est_c, true_c))
                arrow_k = (k, true_c, est_c) if arrow_k is None else arrow_k
            if k - paired >= GUIDE_FRAMES:
                break
            T_next = guided_pose(T, (T @ np.linalg.inv(est) @ np.append(guess, 1))[:3])  # the arrow, seen in the room
        drift = vio_step(rng, drift, T, T_next)
        T = T_next
    res.update(fixes=len(fixes), stages=stages, arrow_err=arrow_err, paired=paired is not None,
               pair_frames=len(stages) if paired is None else paired + 1)
    if first is None:
        return res
    est_c, true_c = to_cam(est, best_guess(fixes)[None]), to_cam(T, pin[None])
    est_px, true_px = project(est_c)[0], project(true_c)[0]
    res.update(relocalized=True, reloc_frame=first, err_cm=100 * float(np.linalg.norm(est_c - true_c)),
               err_px=float(np.linalg.norm(est_px - true_px)))
    if evidence_dir and seed < 3:
        draw_evidence(evidence_dir, case, seed, res, faces, true2, (light, cfg["gradient"], tint), (true_px, est_px), arrow_k)
    return res


def draw_evidence(evidence_dir, case, seed, res, faces, true2, look, marker_px, arrow_k):
    """Marker and arrow frames for the README: same pose and light, without the occluder, so the box is visible."""
    true_px, est_px = marker_px
    draw = R.capture(R.render(faces, true2[-1]), np.random.default_rng(seed), *look)
    cv2.drawMarker(draw, tuple(int(v) for v in true_px), (0, 0, 255), cv2.MARKER_CROSS, 40, 2)
    cv2.circle(draw, tuple(int(v) for v in est_px), 14, (0, 255, 0), 3)
    cv2.putText(draw, f"{case}: {res['err_cm']:.1f} cm, {res['err_px']:.1f} px (green=pin, red=truth)",
                (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.imwrite(os.path.join(evidence_dir, f"{case}-{seed}.jpg"), draw, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if arrow_k is None:
        return
    k, true_c, est_c = arrow_k  # the first frame that showed an arrow
    draw = R.capture(R.render(faces, true2[k]), np.random.default_rng(seed), *look)
    c = np.array([R.W / 2, R.H / 2])
    for Xc, color, width in ((est_c, (0, 255, 0), 6), (true_c, (0, 0, 255), 2)):
        # The arrow ends at the guess when it is on screen, and points toward it from the centre when not.
        tip = project(Xc[None])[0] if on_screen(Xc) else c + 160 * np.array([np.cos(arrow(Xc)), np.sin(arrow(Xc))])
        cv2.arrowedLine(draw, tuple(int(v) for v in c), tuple(int(v) for v in tip), color, width, tipLength=0.25)
    cv2.putText(draw, f"{case}: arrow before the marker (green=app, red=truth)",
                (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.imwrite(os.path.join(evidence_dir, f"{case}-{seed}-arrow.jpg"), draw, [cv2.IMWRITE_JPEG_QUALITY, 80])


def best_guess(fixes):
    """Anchor estimate: mean of the largest group of fixes within AGREE_M of each other."""
    F = np.array(fixes)
    agree = np.linalg.norm(F[:, None] - F[None], axis=2) < AGREE_M
    return F[agree[agree.sum(1).argmax()]].mean(0)


def on_screen(Xc, margin=40):
    if Xc[2] < 0.2:
        return False
    u, v = project(Xc[None])[0]
    return margin <= u <= R.W - margin and margin <= v <= R.H - margin


def arrow(Xc):
    """Screen direction (radians, image axes) to turn toward a camera-frame point, ahead of or behind the camera.
    With fx == fy the projection's direction from the image centre is atan2(y, x) for points ahead."""
    return np.arctan2(Xc[1], Xc[0])


def ray_angle_deg(a, b):
    """How far off the arrow sends the person: the angle between the view rays to a and to b."""
    return float(np.degrees(np.arccos(np.clip(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)), -1, 1))))


def summarize(rows):
    ok = [r for r in rows if r["relocalized"]]
    cm, px = np.array([r["err_cm"] for r in ok]), np.array([r["err_px"] for r in ok])
    arrows = np.array([e for r in rows for e in r.get("arrow_err", [])])
    turn = np.array([PAIR_STEP_DEG * (r["pair_frames"] - 1) for r in rows if r.get("paired")])
    pct = lambda a, q: float(np.percentile(a, q)) if len(a) else float("nan")
    return {
        "trials": len(rows), "saved": sum(r["saved"] for r in rows), "reloc_rate": len(ok) / len(rows),
        "paired": sum(r.get("paired", False) for r in rows) / len(rows),
        "pair_turn_median": pct(turn, 50), "pair_turn_p95": pct(turn, 95),
        "err_cm_median": pct(cm, 50), "err_cm_p95": pct(cm, 95), "err_cm_max": pct(cm, 100),
        "err_px_median": pct(px, 50), "err_px_p95": pct(px, 95), "err_px_max": pct(px, 100),
        "within_bar": sum(r["err_cm"] <= PASS["err_cm"] and r["err_px"] <= PASS["err_px"] for r in ok) / len(rows),
        "arrow_frames": len(arrows), "arrow_deg_median": pct(arrows, 50), "arrow_deg_p95": pct(arrows, 95),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trials", type=int, default=50, help="baseline trials (default 50)")
    ap.add_argument("--failure-trials", type=int, default=20, help="trials per failure case (default 20)")
    ap.add_argument("--quick", action="store_true", help="CI size: 24 baseline trials, no failure cases")
    ap.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    a = ap.parse_args()
    if a.quick:
        a.trials, a.failure_trials = 24, 0  # failure trials spend all 48 pairing frames; the full run covers them
    os.makedirs(a.out, exist_ok=True)
    jobs = [("baseline", s, a.out) for s in range(a.trials)]
    jobs += [(c, s, a.out) for c in CASES if c != "baseline" for s in range(a.failure_trials)]
    t0 = time.time()
    with Pool(a.workers) as pool:
        rows = pool.map(trial, jobs, chunksize=1)
    summary = {c: summarize([r for r in rows if r["case"] == c]) for c in CASES if any(r["case"] == c for r in rows)}
    lines = [("| case | trials | map saved | pairing done | pairing turn deg (median / p95) | marker shown"
              " | 3D error cm (median / p95 / max) | screen error px (median / p95 / max)"
              " | within 5 cm and 20 px | arrow frames | arrow error deg (median / p95) |"),
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for c, s in summary.items():
        lines.append(f"| {c} | {s['trials']} | {s['saved'] / s['trials']:.0%} | {s['paired']:.0%}"
                     f" | {s['pair_turn_median']:.0f} / {s['pair_turn_p95']:.0f} | {s['reloc_rate']:.0%}"
                     f" | {s['err_cm_median']:.2f} / {s['err_cm_p95']:.2f} / {s['err_cm_max']:.2f}"
                     f" | {s['err_px_median']:.1f} / {s['err_px_p95']:.1f} / {s['err_px_max']:.1f} | {s['within_bar']:.0%}"
                     f" | {s['arrow_frames']} | {s['arrow_deg_median']:.1f} / {s['arrow_deg_p95']:.1f} |")
    b = summary["baseline"]
    passed = (b["paired"] >= PASS["paired"] and b["reloc_rate"] >= PASS["reloc_rate"] and b["err_cm_p95"] <= PASS["err_cm"]
              and b["err_px_p95"] <= PASS["err_px"] and b["arrow_deg_p95"] <= PASS["arrow_deg"])
    table = "\n".join(lines)
    print(table)
    print(f"\nbaseline gate (pairing >= 95%, marker >= 90%, p95 <= 5 cm and <= 20 px, arrow p95 <= {PASS['arrow_deg']:.0f} deg):"
          f" {'PASS' if passed else 'FAIL'}  ({time.time() - t0:.0f} s)")
    with open(os.path.join(a.out, "results.json"), "w") as f:
        json.dump({"pass": passed, "summary": summary, "trials": rows}, f, indent=1)
    with open(os.path.join(a.out, "results.md"), "w") as f:
        f.write(table + "\n")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
