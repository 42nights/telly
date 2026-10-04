#!/usr/bin/env python3
"""Telly AR pin simulation, many objects: N containers pinned in one room share one world map.

Session 1 scans each furniture group that holds containers, builds one feature map for the room, and
pins every container from 0.6 to 0.9 m (LiDAR depth, or the map-point hit test). Session 2 pairs once,
then projects every anchor: once two fixes agree, a marker for each anchor on screen within 2 m, and an
arrow for each other one, nearest first. The person follows the arrow to the nearest container that has
not shown a marker yet. Procedures and results: docs/ar-sim/.

    python tools/ar-sim/multi.py                        # 8 rooms for each N in 1, 3, 5, 10, 20; exit 1 below the bar
    python tools/ar-sim/multi.py --map-without-drift    # the same rooms without session-1 VIO drift
    python tools/ar-sim/multi.py --pin points           # the same rooms with the map-point hit test
    python tools/ar-sim/multi.py --quick --map-without-drift   # CI: 4 rooms with N = 20, same gate
"""

import argparse
import base64
import io
import json
import os
import resource
import sys
import time
import zlib
from multiprocessing import Pool

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R
import run as S

NS = (1, 3, 5, 10, 20)
SCAN_FRAMES = 16  # session 1, per furniture group: an arc of 120 degrees
WINDOW = 8  # an anchor guess uses the last 8 fixes, so VIO drift on a long walk does not keep stale fixes
HOLD = 3  # frames the person holds still after a fix that no second fix confirms yet
MARKER_M = 2.0  # a labelled marker shows only within 2 m of the camera; farther away, the arrow stays
MAX_VIEW_DEG = 50  # people tap the face they see: the tap view is at most 50 degrees off its normal
GUIDE_MAX = 60  # frames after pairing to show every marker
SEC_PER_FRAME = 0.5  # pairing turns 15 degrees per frame at about 30 degrees per second
FIRST_BOX = 4  # boxes from make_multi_scene: cabinet, sofa, bookshelf, table, then one per container
PASS = {"reloc_rate": 0.90, "shown": 0.90, "err_cm": 5.0, "err_px": 20.0, "arrow_deg": 15.0}


def vio_walk(rng, poses, step=0.15):
    """VIO for a path with long walks between frames (session 1 walks from one furniture group to the
    next): the drift grows for every 15 cm walked, as it does for every camera frame of a real walk."""
    origin, drift, out, prev = np.linalg.inv(poses[0]), np.eye(4), [np.eye(4)], poses[0]
    for T in poses[1:]:
        n = max(1, int(np.linalg.norm(T[:3, 3] - prev[:3, 3]) / step))
        for s in range(1, n + 1):
            Ti = T.copy()
            Ti[:3, 3] = prev[:3, 3] + (T[:3, 3] - prev[:3, 3]) * s / n
            drift = S.vio_step(rng, drift, prev, Ti)
            prev = Ti
        out.append(drift @ origin @ T)
    return out


def hidden(eye, p, lo, hi, own):
    """True when a solid box, other than the container's own, blocks the line of sight from eye to p."""
    d = p - eye
    with np.errstate(divide="ignore", invalid="ignore"):
        t0, t1 = (lo - eye) / d, (hi - eye) / d
    tmin, tmax = np.minimum(t0, t1).max(1), np.maximum(t0, t1).min(1)
    hit = (tmax >= np.maximum(tmin, 0)) & (tmin < 0.99)
    hit[own] = False
    return bool(hit.any())


def guesses(fixes, fix_seg, anchor_seg):
    """Anchor guesses from the fixes, and whether two of them agree. Two fixes agree when they put every
    anchor within AGREE_M of each other (one map-to-session transform moves all anchors, as in ARKit).
    Of the last WINDOW fixes, the group holding the latest fix wins when it has two fixes, else the
    largest group. The parts of the map disagree by the drift of the walks between them, so the anchors
    of each part then use the agreeing group of that part's own last WINDOW fixes, when there is one."""
    F, fs = np.array(fixes), np.array(fix_seg)  # (fixes, anchors, 3), (fixes,)

    def group(idx):
        agree = (np.linalg.norm(F[idx, None] - F[None, idx], axis=3) < S.AGREE_M).all(2)
        return idx[agree[-1] if agree[-1].sum() >= 2 else agree[agree.sum(1).argmax()]]

    g = group(np.arange(len(F))[-WINDOW:])
    guess = F[g].mean(0)
    for s in set(anchor_seg.tolist()):
        own = np.flatnonzero(fs == s)[-WINDOW:]
        if len(own) >= 2 and len(go := group(own)) >= 2:
            guess[anchor_seg == s] = F[go][:, anchor_seg == s].mean(0)
    return guess, len(g) >= 2


def relocalize(bf, feat, pts, des, seg):
    """(pose, map part) from the part with the most ORB matches that gives a fix, or None."""
    if feat[1] is None:
        return None
    counts = np.bincount(seg[[x.trainIdx for x in bf.match(feat[1], des) if x.distance < 50]], minlength=seg.max() + 1)
    for j in np.argsort(-counts):
        if counts[j] < S.MIN_INLIERS:
            break
        T = S.relocalize(bf, feat, pts[seg == j], des[seg == j])
        if T is not None:
            return T, int(j)
    return None


def onto_map(bf, feats, est, frames, pts, des):
    """The correction that moves a group of VIO poses onto a map: the mean of PnP fix @ inv(VIO pose)
    over the fixes that agree (rotation projected back onto SO(3)), or None. As for the marker, one PnP
    fix can be confidently wrong, so the correction needs two fixes that put the camera within 2 cm."""
    Cs = [T @ np.linalg.inv(est[a]) for a in frames if len(pts) and (T := S.relocalize(bf, feats[a], pts, des)) is not None]
    cam = np.array([c[:3, :3] @ est[frames[0]][:3, 3] + c[:3, 3] for c in Cs]).reshape(-1, 3)
    near = np.linalg.norm(cam[:, None] - cam[None], axis=2) < 0.02
    if not len(Cs) or near.sum(1).max() < 2:
        return None
    Cs = [c for c, ok in zip(Cs, near[near.sum(1).argmax()]) if ok]
    U, _, Vt = np.linalg.svd(sum(c[:3, :3] for c in Cs))
    C = np.eye(4)
    C[:3, :3], C[:3, 3] = U @ Vt, np.mean([c[:3, 3] for c in Cs], 0)
    return C


def depth_at(inv_z, tap, rng):
    """LiDAR depth at the tap pixel, as ARKit `sceneDepth` gives it on Pro iPhones: a 256 x 192 depth map
    (one depth pixel per 3.75 px here, a 4 x 4 block), with noise of 0.3 cm plus 1 percent. Assumed
    values, like the VIO drift. A block that spans more than 3 cm of depth is an edge, where ARKit's
    confidence map is low: None, and the app asks the person to tap the middle of the box."""
    x, y = np.round(tap).astype(int)
    block = inv_z[max(y - 2, 0) : y + 2, max(x - 2, 0) : x + 2]
    z = 1 / block[block > 0]
    if not len(z) or z.max() - z.min() > 0.03:
        return None
    return np.median(z) * (1 + rng.normal(0, 0.01)) + rng.normal(0, 0.003)


def room(job):
    n, seed, out_dir, map_drift, pin = job
    cv2.setNumThreads(1)
    rng = np.random.default_rng(1000 * n + seed)
    orb, bf = cv2.ORB_create(nfeatures=2000), cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    faces, objs, boxes, surfaces = R.make_multi_scene(rng, n)
    lo_b, hi_b = np.array([b[0] for b in boxes]), np.array([b[1] for b in boxes])
    pins = np.array([o["pin"] for o in objs])
    res = {"n": n, "seed": seed, "pinned": 0, "paired": False}

    # Session 1: per furniture group, an arc over the group, then the person steps up to each container
    # on it and taps it from 0.6 to 0.9 m ("Move closer so the medicine fills the circle"). From 2 m, a
    # 20 px hit-test window is 6 cm wide and takes in the neighbours 10 cm away. The last 20 cm of the
    # step is sideways (4 frames), so the tracker maps the container itself before the tap: one frame
    # straight at it adds no map points. One map for the room.
    groups = sorted({o["surface"] for o in objs})
    true1, segs, taps = [], [], {}
    for s in groups:
        start, phi = len(true1), surfaces[s][5]
        true1 += S.scan_path(rng, pins[[o["surface"] == s for o in objs]].mean(0), 120, SCAN_FRAMES, phi=phi)
        side = np.array([-np.sin(phi), np.cos(phi), 0])
        for i in sorted((i for i, o in enumerate(objs) if o["surface"] == s), key=lambda i: pins[i] @ side):
            for t in range(16):  # front views first; step around or raise the phone while something hides it
                a = phi + rng.uniform(-1, 1) * (0.3 + 0.9 * t / 15)
                eye = pins[i] + rng.uniform(0.6, 0.9) * np.array([np.cos(a), np.sin(a), 0]) + (0, 0, 0.25 + rng.uniform(0, 0.15 + 0.5 * t / 15))
                eye = np.clip(eye, 0.15, np.array(R.ROOM) - 0.15)  # inside the room
                v = (eye - pins[i]) / np.linalg.norm(eye - pins[i])  # people tap the face they see: at most 50 degrees off it
                if v @ (np.cos(phi), np.sin(phi), 0) >= np.cos(np.radians(MAX_VIEW_DEG)) and not hidden(eye, pins[i], lo_b, hi_b, FIRST_BOX + i):
                    d = pins[i] - eye
                    step = np.array([-d[1], d[0], 0]) / np.linalg.norm(d[:2]) * 0.07 * rng.choice((-1, 1))
                    true1 += [S.look_at(eye + step * (j - 3), pins[i] + rng.normal(0, 0.03, 3)) for j in range(4)]
                    taps[i] = len(true1) - 1
                    break
        segs.append(slice(start, len(true1)))
    est1 = vio_walk(rng, true1)
    if not map_drift:  # the bound for a map whose drift global optimisation removed (same random draws)
        est1 = [np.linalg.inv(true1[0]) @ T for T in true1]
    imgs = [R.capture(R.render(faces, T), rng, light=rng.uniform(0.9, 1.1), gradient=0.1, blur_px=rng.uniform(0, 4)) for T in true1]
    feats = [S.features(orb, im) for im in imgs]
    del imgs
    # SLAM, not dead reckoning: while the person steps up to a container, the tracker tracks against the
    # arc that it just mapped. Each 4-frame step keeps its VIO motion but moves onto the arc map by the
    # mean of its PnP fixes. Without this, the VIO drift of the walk from the arc to the container goes
    # straight into the pin. This sim has no global bundle adjustment, so the parts of the map scanned
    # from different furniture keep the drift of the walks between them: each point keeps its part
    # (`seg`), and relocalization solves against one part at a time, as a tracker relocalizes against
    # nearby keyframes.
    parts = []
    for g in segs:
        arc = slice(g.start, g.start + SCAN_FRAMES)
        part = [S.build_map(feats[arc], est1[arc], bf)]
        for k in (t for t in taps.values() if g.start <= t < g.stop):
            C = onto_map(bf, feats, est1, range(k - 3, k + 1), *part[0])
            for a in range(k - 3, k + 1) if C is not None else ():
                est1[a] = C @ est1[a]
            part.append(S.build_map(feats[k - 3 : k + 1], est1[k - 3 : k + 1], bf))  # the container, seen from 20 cm of sideways step
        parts.append((np.concatenate([p for p, _ in part]), np.concatenate([d for _, d in part])))
    pts, des = np.concatenate([p for p, _ in parts]), np.concatenate([d for _, d in parts])
    seg = np.concatenate([np.full(len(p), j, np.int8) for j, (p, _) in enumerate(parts)])
    _, keep = np.unique(np.round(pts / 0.01), axis=0, return_index=True)
    pts, des, seg = pts[keep], des[keep], seg[keep]
    # The pin: the tap ray at the LiDAR depth (`depth`, Pro iPhones), or at the median depth of the map
    # points around the tap (`points`, the single-object hit test, every ARKit iPhone).
    anchors, save_err = np.full((n, 3), np.nan), []
    for i, k in taps.items():
        true_c = S.to_cam(true1[k], pins[i][None])
        tap = S.project(true_c)[0]
        if pin == "depth":
            z = depth_at(R.render(faces, true1[k], depth=True)[1], tap, np.random.default_rng((seed, i)))
            hit = None if z is None else est1[k][:3, :3] @ (np.linalg.inv(R.K) @ (*tap, 1.0) * z) + est1[k][:3, 3]
        else:
            own = seg == groups.index(objs[i]["surface"])
            hit = S.raycast(est1[k], tap, pts[own]) if own.any() else None
        if hit is not None:
            anchors[i] = hit
            save_err.append(100 * float(np.linalg.norm(S.to_cam(est1[k], hit[None]) - true_c)))  # as the tap frame sees it
    pinned = ~np.isnan(anchors[:, 0])
    res.update(pinned=int(pinned.sum()), map_points=len(pts), save_err=save_err)
    if not pinned.any():
        return res
    T_a = np.tile(np.eye(4), (n, 1, 1))
    T_a[:, :3, 3] = np.nan_to_num(anchors)
    buf = io.BytesIO()
    names = np.array([f"telly-pin-box-{i}" for i in range(n)])
    np.savez(buf, points=pts, descriptors=des, segments=seg, anchor_names=names[pinned], anchor_transforms=T_a[pinned])
    blob = zlib.compress(buf.getvalue(), 6)
    res.update(map_bytes=len(blob), map_raw_bytes=len(buf.getvalue()))
    world_map = json.loads(json.dumps({"worldMap": base64.b64encode(blob).decode()}))["worldMap"]  # through the bridge
    m = np.load(io.BytesIO(zlib.decompress(base64.b64decode(world_map))))
    mpts, mdes, mseg, A = m["points"], m["descriptors"], m["segments"], m["anchor_transforms"][:, :3, 3]
    ids = np.flatnonzero(pinned)
    P = pins[ids]

    # Session 2: the person asks for the first pinned container and starts somewhere in front of it.
    tp, phi_s = P[0], surfaces[objs[ids[0]]["surface"]][5]
    phi, r = phi_s + rng.uniform(-1.0, 1.0), rng.uniform(1.0, 2.6)
    eye = S.in_room(tp + (r * np.cos(phi), r * np.sin(phi), rng.uniform(1.0, 1.7) - tp[2]))
    yaw0 = rng.uniform(0, 2 * np.pi)
    light, tint = rng.uniform(*S.BASE["light"]), 1 + rng.uniform(-S.BASE["tint"], S.BASE["tint"], 3)
    remembered = tp + np.append(rng.normal(0, 0.5, 2), 0)
    T = S.pairing_pose(eye, 0, yaw0)
    origin, drift = np.linalg.inv(T), np.eye(4)
    mm, anchor_seg = len(ids), np.array([groups.index(objs[i]["surface"]) for i in ids])
    true2, fixes, fix_seg, paired, frames, stages, turn, last_fix = [], [], [], None, [], "", 0, None
    seen, bad, err_cm, err_px = np.zeros(mm, bool), np.zeros(mm, bool), np.zeros(mm), np.zeros(mm)
    first, every, wrong, displays, hid, arrows, most_arrows = None, None, 0, 0, 0, [], 0
    while True:
        k, est = len(true2), drift @ origin @ T
        true2.append(T)
        img = R.capture(R.render(faces, T), rng, light, S.BASE["gradient"], tint, rng.uniform(0, 6), occluder=True)
        fix = relocalize(bf, S.features(orb, img), mpts, mdes, mseg)
        if fix is not None:
            fixes.append(S.to_cam(fix[0] @ np.linalg.inv(est), A))
            fix_seg.append(fix[1])
            paired, last_fix = (k if paired is None else paired), k
        if not fixes:  # stages: P pairing, A arrows, F arrows and a fix this frame, "n," n markers
            stages += "P"
            if k + 1 >= S.PAIR_MAX:
                break
            turn += 1
            if turn >= 360 // S.PAIR_STEP_DEG:
                eye = S.walk_closer(eye, remembered)
            T_next = S.pairing_pose(eye, turn, yaw0)
        else:
            guess, conf = guesses(fixes, fix_seg, anchor_seg)
            est_c, true_c = S.to_cam(est, guess), S.to_cam(T, P)
            # A labelled marker only within MARKER_M: farther away, boxes 10 cm apart are under 40 px
            # apart on the screen, too close for a marker that may be 10 to 20 px off. The arrow stays.
            marker = conf & np.array([S.on_screen(x) and np.linalg.norm(x) <= MARKER_M for x in est_c])
            q = np.where(true_c[:, 2:] > 0.2, S.project(np.where(true_c[:, 2:] > 0.2, true_c, 1.0)), 1e6)  # behind: far off screen
            for j in np.flatnonzero(marker):
                p = S.project(est_c[j][None])[0]
                err_cm[j] = max(err_cm[j], 100 * np.linalg.norm(est_c[j] - true_c[j]))
                err_px[j] = max(err_px[j], np.linalg.norm(p - q[j]) if true_c[j, 2] > 0.2 else np.inf)  # inf: the box is behind the camera
                # Wrong marker: nearer another container in 3D, or on screen where the two are 20 px apart.
                apart = (np.linalg.norm(q - q[j], axis=1) >= 20) | (np.arange(mm) == j)
                d_px = np.where(apart, np.linalg.norm(q - p, axis=1), np.inf)
                w = np.linalg.norm(true_c - est_c[j], axis=1).argmin() != j or d_px.argmin() != j
                wrong, bad[j] = wrong + int(w), bad[j] or w
                displays += 1
                hid += hidden(T[:3, 3], P[j], lo_b, hi_b, FIRST_BOX + ids[j])
            if marker.any() and first is None:
                first = k
            seen |= marker
            stages += f"{int(marker.sum())}," if marker.any() else ("F" if fix is not None else "A")
            off = np.flatnonzero(~marker)
            off = off[np.argsort(np.linalg.norm(est_c[off], axis=1))]  # the arrows, nearest first
            arrows += [S.ray_angle_deg(est_c[j], true_c[j]) for j in off]
            most_arrows = max(most_arrows, len(off))
            frames.append((k, est_c, true_c, marker, off))
            if seen.all():
                every = k
                break
            if k - paired >= GUIDE_MAX:
                break
            if not conf:
                # One fix, or fixes that disagree: "Hold still" for up to HOLD frames, so the second fix
                # comes from the same mapped view, then keep turning. Walking toward one unconfirmed fix
                # leads to views the scan never saw, and the second fix may never come.
                if k - last_fix >= HOLD:
                    turn += 1
                T_next = S.pairing_pose(eye, turn, yaw0)
            else:
                todo = np.flatnonzero(~seen)
                goal = todo[np.linalg.norm(est_c[todo], axis=1).argmin()]
                T_next = S.guided_pose(T, (T @ np.linalg.inv(est) @ np.append(guess[goal], 1))[:3])
        drift = S.vio_step(rng, drift, T, T_next)
        T = T_next
    res.update(paired=paired is not None, relocalized=first is not None, shown=int(seen.sum()), stages=stages,
               err_cm=err_cm[seen].tolist(), err_px=err_px[seen].tolist(), wrong=wrong, wrong_objects=int(bad.sum()), displays=displays,
               hidden_displays=int(hid), arrows=arrows, most_arrows=most_arrows,
               first_s=None if first is None else (first + 1) * SEC_PER_FRAME,
               all_s=None if every is None else (every + 1) * SEC_PER_FRAME,
               peak_rss_mb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
    if out_dir and seed == 0 and frames and map_drift and pin == "depth":
        draw_frames(out_dir, n, faces, true2, frames, light, tint, ids)
    return res


def draw_frames(out_dir, n, faces, true2, frames, light, tint, ids):
    """The frame with the most markers, and the first frame with three or more arrows (without the
    occluder, so the containers show). Green ring: marker. Red cross: the true point. Yellow arrows
    at the screen edge: containers off screen or not yet confident, numbered nearest first."""
    best = max(frames, key=lambda f: f[3].sum())
    arrow_f = next((f for f in frames if len(f[4]) >= 3), None)
    for name, f in (("markers", best), ("arrows", arrow_f)):
        if f is None:
            continue
        k, est_c, true_c, marker, off = f
        img = R.capture(R.render(faces, true2[k]), np.random.default_rng(0), light, S.BASE["gradient"], tint)
        for j in np.flatnonzero(marker):
            p, t = S.project(est_c[j][None])[0], S.project(true_c[j][None])[0]
            cv2.drawMarker(img, tuple(int(v) for v in t), (0, 0, 255), cv2.MARKER_CROSS, 22, 2)
            cv2.circle(img, tuple(int(v) for v in p), 10, (0, 255, 0), 2)
            cv2.putText(img, str(ids[j]), (int(p[0]) + 9, int(p[1]) - 9), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
        c = np.array([R.W / 2, R.H / 2])
        for rank, j in enumerate(off):
            a = S.arrow(est_c[j])
            u = np.array([np.cos(a), np.sin(a)])
            tip = c + u * min((R.W / 2 - 30) / max(abs(u[0]), 1e-6), (R.H / 2 - 30) / max(abs(u[1]), 1e-6))
            if S.on_screen(est_c[j]):  # on screen, not yet confident: the arrow ends at the guess
                tip = S.project(est_c[j][None])[0]
            tail = tip - 50 * u
            cv2.arrowedLine(img, tuple(int(v) for v in tail), tuple(int(v) for v in tip), (0, 230, 255), 5 if rank == 0 else 2, tipLength=0.35)
            cv2.putText(img, f"{rank + 1}:{ids[j]} {np.linalg.norm(est_c[j]):.1f}m", tuple(int(v) for v in tail - 30 * u + (-30, 5)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 230, 255), 1)
        cv2.putText(img, f"N={n}: {int(marker.sum())} markers, {len(off)} arrows (green=marker, red=truth, yellow=arrow #:box)",
                    (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        cv2.imwrite(os.path.join(out_dir, f"multi-{n}-{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 80])


def summarize(rows):
    pct = lambda a, q: float(np.percentile(a, q)) if len(a) else float("nan")
    cm = np.array([e for r in rows for e in r.get("err_cm", [])])
    px = np.array([e for r in rows for e in r.get("err_px", [])])
    arrows = np.array([e for r in rows for e in r.get("arrows", [])])
    first = np.array([r["first_s"] for r in rows if r.get("first_s") is not None])
    every = np.array([r["all_s"] for r in rows if r.get("all_s") is not None])
    kb = np.array([r["map_bytes"] / 1024 for r in rows if "map_bytes" in r])
    n, pinned = sum(r["n"] for r in rows), sum(r["pinned"] for r in rows)
    displays = sum(r.get("displays", 0) for r in rows)
    save = np.array([e for r in rows for e in r.get("save_err", [])])
    return {
        "rooms": len(rows), "objects": n, "pinned": pinned / n,
        "paired": sum(r["paired"] for r in rows) / max(sum(r["pinned"] > 0 for r in rows), 1),
        "reloc_rate": sum(r.get("relocalized", False) for r in rows) / max(sum(r["pinned"] > 0 for r in rows), 1),  # rooms with a pin
        "shown": sum(r.get("shown", 0) for r in rows) / max(pinned, 1),
        "err_cm_median": pct(cm, 50), "err_cm_p95": pct(cm, 95), "err_cm_max": float(cm.max()) if len(cm) else float("nan"),
        "err_px_median": pct(px, 50), "err_px_p95": pct(px, 95), "err_px_max": float(px.max()) if len(px) else float("nan"),
        "save_cm_median": pct(save, 50), "save_cm_p95": pct(save, 95),
        "displays": displays, "wrong": sum(r.get("wrong", 0) for r in rows),
        "wrong_objects": sum(r.get("wrong_objects", 0) for r in rows),
        "hidden_share": sum(r.get("hidden_displays", 0) for r in rows) / max(displays, 1),
        "first_s_median": pct(first, 50), "first_s_p95": pct(first, 95),
        "all_s_median": pct(every, 50), "all_s_p95": pct(every, 95),
        "all_rate": len(every) / max(sum(r["pinned"] > 0 for r in rows), 1),
        "arrow_frames": len(arrows), "arrow_deg_median": pct(arrows, 50), "arrow_deg_p95": pct(arrows, 95),
        "most_arrows": max((r.get("most_arrows", 0) for r in rows), default=0),
        "map_kb_median": pct(kb, 50), "map_kb_max": pct(kb, 100),
        "map_points_median": pct([r["map_points"] for r in rows], 50),
        "decoded_mb_max": max((r.get("map_raw_bytes", 0) / 2**20 for r in rows), default=0),
        "peak_rss_mb": max((r.get("peak_rss_mb", 0) for r in rows), default=0),
    }


def passes(s):
    return (s["wrong"] == 0 and s["reloc_rate"] >= PASS["reloc_rate"] and s["shown"] >= PASS["shown"]
            and s["err_cm_p95"] <= PASS["err_cm"] and s["err_px_p95"] <= PASS["err_px"] and s["arrow_deg_p95"] <= PASS["arrow_deg"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rooms", type=int, default=8, help="rooms per N (default 8)")
    ap.add_argument("--quick", action="store_true", help="CI size: 4 rooms with N = 20")
    ap.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    ap.add_argument("--pin", choices=("depth", "points"), default="depth",
                    help="pin hit test: LiDAR depth (Pro iPhones, default) or the median depth of map points (every ARKit iPhone)")
    ap.add_argument("--map-without-drift", action="store_true",
                    help="bound: session 1 poses without VIO drift, as if global map optimisation removed it")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    a = ap.parse_args()
    tag = f"multi-{a.pin}" + ("-no-drift" if a.map_without_drift else "")
    ns = (20,) if a.quick else NS
    rooms = 4 if a.quick else a.rooms
    os.makedirs(a.out, exist_ok=True)
    jobs = sorted(((n, s, a.out, not a.map_without_drift, a.pin) for n in ns for s in range(rooms)), key=lambda j: -j[0])  # big rooms first
    t0 = time.time()
    with Pool(a.workers, maxtasksperchild=1) as pool:  # one process per room, so peak RSS is per room
        rows = pool.map(room, jobs, chunksize=1)
    summary = {n: summarize([r for r in rows if r["n"] == n]) for n in ns}
    lines = [("| N | rooms | pinned | relocalized | markers shown | pin error at save cm (median / p95)"
              " | 3D error cm (median / p95 / max) | screen error px (median / p95 / max)"
              " | wrong markers (boxes / marker frames) | marker on a hidden box |"),
             "|---|---|---|---|---|---|---|---|---|---|"]
    for n, s in summary.items():
        lines.append(f"| {n} | {s['rooms']} | {s['pinned']:.0%} | {s['reloc_rate']:.0%} | {s['shown']:.0%}"
                     f" | {s['save_cm_median']:.2f} / {s['save_cm_p95']:.2f}"
                     f" | {s['err_cm_median']:.2f} / {s['err_cm_p95']:.2f} / {s['err_cm_max']:.2f}"
                     f" | {s['err_px_median']:.1f} / {s['err_px_p95']:.1f} / {s['err_px_max']:.1f}"
                     f" | {s['wrong_objects']} / {s['wrong']} of {s['displays']} | {s['hidden_share']:.0%} |")
    lines += ["", ("| N | first marker s (median / p95) | all markers s (median / p95) | all shown"
                   " | arrow error deg (median / p95) | most arrows at once | map KB (median / max)"
                   " | N copies of the map KB | map points (median) | peak RSS MB |"),
              "|---|---|---|---|---|---|---|---|---|---|"]
    for n, s in summary.items():
        lines.append(f"| {n} | {s['first_s_median']:.1f} / {s['first_s_p95']:.1f} | {s['all_s_median']:.1f} / {s['all_s_p95']:.1f}"
                     f" | {s['all_rate']:.0%} | {s['arrow_deg_median']:.1f} / {s['arrow_deg_p95']:.1f} | {s['most_arrows']}"
                     f" | {s['map_kb_median']:.0f} / {s['map_kb_max']:.0f} | {n * s['map_kb_median']:.0f}"
                     f" | {s['map_points_median']:.0f} | {s['peak_rss_mb']:.0f} |")
    passed = all(passes(s) for s in summary.values())
    table = "\n".join(lines)
    print(table)
    print(f"\nmulti gate (every N: 0 wrong markers, relocalized >= 90%, markers shown >= 90%, p95 <= 5 cm and <= 20 px,"
          f" arrow p95 <= 15 deg): {'PASS' if passed else 'FAIL'}  ({time.time() - t0:.0f} s)")
    with open(os.path.join(a.out, f"{tag}.json"), "w") as f:
        json.dump({"pass": passed, "summary": summary, "rooms": rows}, f, indent=1)
    with open(os.path.join(a.out, f"{tag}.md"), "w") as f:
        f.write(table + "\n")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
