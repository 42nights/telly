"""Headless renderer and camera model for the Telly AR pin simulation.

The scene is a set of textured axis-aligned boxes; the room is one box seen from inside. Each face is
drawn with one plane homography (cv2.warpPerspective), clipped at the near plane, and resolved with a
per-pixel inverse-depth z-buffer. No GPU, no OpenGL: it runs on any Linux CI runner.

`capture` turns a render into what an iPhone camera would deliver: scene lighting (level, gradient,
colour cast), an optional occluding object, motion blur, shot and read noise, auto exposure, 8 bits.
"""

import cv2
import numpy as np

W, H = 960, 720
# ARKit delivers 1920x1440 frames from the iPhone wide camera with fx ~ 1500 px (about 65 degrees
# horizontal FOV). The sim keeps the FOV at half the resolution to stay fast on shared runners.
K = np.array([[750.0, 0.0, (W - 1) / 2], [0.0, 750.0, (H - 1) / 2], [0.0, 0.0, 1.0]])
_u, _v = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
RAYS = np.stack([_u, _v, np.ones_like(_u)], -1) @ np.linalg.inv(K).T.astype(np.float32)
PX_PER_M = 256
NEAR = 0.05
ROOM = (5.0, 4.0, 2.6)
LETTERS = np.array(list("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))


def texture(rng, w_m, h_m, kind, px_per_m=PX_PER_M):
    """Procedural texture: `rich` (posters, books, clutter), `plain` (matte paint), `label` (medicine box)."""
    tw, th = max(8, int(w_m * px_per_m)), max(8, int(h_m * px_per_m))
    img = np.empty((th, tw, 3), np.float32)
    if kind == "label":
        img[:] = (235, 240, 245)
        cv2.rectangle(img, (0, 0), (tw, th // 5), tuple(float(c) for c in rng.uniform(0, 255, 3)), -1)
    else:
        img[:] = rng.uniform(70, 210, 3)
    if kind == "plain":
        # Painted wall: faint low-frequency shading and paint grain, nothing a corner detector can hold.
        img += cv2.resize(rng.normal(0, 4, (4, 4)).astype(np.float32), (tw, th))[..., None]
        img += rng.normal(0, 1.0, (th, tw, 1)).astype(np.float32)
        return np.clip(img, 0, 255).astype(np.uint8)
    for s in (64, 16, 4):
        n = rng.normal(0, 8, (max(2, th // s), max(2, tw // s))).astype(np.float32)
        img += cv2.resize(n, (tw, th), interpolation=cv2.INTER_CUBIC)[..., None]
    items = int(w_m * h_m * 8) if kind == "rich" else 18
    scale = px_per_m / PX_PER_M
    for _ in range(items):
        x, y = int(rng.integers(0, tw)), int(rng.integers(0, th))
        color = tuple(float(c) for c in rng.uniform(0, 255, 3))
        size = int(rng.integers(6, 90) * (0.25 if kind == "label" else 1) * scale)
        shape = int(rng.integers(4))
        if shape == 0:
            cv2.rectangle(img, (x, y), (x + size, y + int(rng.integers(6, 90) * scale)), color, -1)
        elif shape == 1:
            cv2.circle(img, (x, y), max(2, size // 2), color, -1)
        elif shape == 2:
            end = (x + int(rng.integers(-size, size + 1)), y + int(rng.integers(-size, size + 1)))
            cv2.line(img, (x, y), end, color, int(rng.integers(1, 5)))
        else:
            word = "".join(rng.choice(LETTERS, int(rng.integers(3, 8))))
            cv2.putText(img, word, (x, y), cv2.FONT_HERSHEY_SIMPLEX, rng.uniform(0.4, 1.6) * scale, color, 2)
    return np.clip(img, 0, 255).astype(np.uint8)


def box_faces(rng, lo, hi, kind, inward=False, px_per_m=PX_PER_M):
    """Six textured faces (origin, u edge, v edge, outward normal, texture) of an axis-aligned box."""
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    faces = []
    for a in range(3):
        u_ax, v_ax = {0: (1, 2), 1: (0, 2), 2: (0, 1)}[a]
        for corner, sign in ((lo, -1.0), (hi, 1.0)):
            n = np.zeros(3)
            n[a] = -sign if inward else sign
            o = lo.copy()
            o[a] = corner[a]
            u, v = np.zeros(3), np.zeros(3)
            u[u_ax] = hi[u_ax] - lo[u_ax]
            v[v_ax] = hi[v_ax] - lo[v_ax]
            if v_ax == 2:  # walls: texture rows run downward
                o[2], v = hi[2], -v
            tex = texture(rng, np.linalg.norm(u), np.linalg.norm(v), kind, px_per_m)
            faces.append((o, u, v, n, tex))
    return faces


def make_scene(rng, plain_walls=False):
    """Randomized living room with a medicine box on a cabinet; returns (faces, true pin point)."""
    faces = box_faces(rng, (0, 0, 0), ROOM, "plain" if plain_walls else "rich", inward=True)
    cab_y = rng.uniform(0.3, 2.5)
    faces += box_faces(rng, (4.4, cab_y, 0), (4.98, cab_y + 1.2, 0.85), "rich")  # cabinet
    faces += box_faces(rng, (0.4, 3.3, 0), (2.6, 3.95, 0.8), "rich")  # sofa
    faces += box_faces(rng, (0.05, 0.6, 0), (0.4, 1.8, 1.9), "rich")  # bookshelf
    bx, by = rng.uniform(4.45, 4.75), rng.uniform(cab_y + 0.1, cab_y + 0.98)
    faces += box_faces(rng, (bx, by, 0.85), (bx + 0.08, by + 0.12, 1.0), "label", px_per_m=1200)
    return faces, np.array([bx, by + 0.06, 0.925])  # centre of the face toward the room


def _clip_near(poly):
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        if a[2] >= NEAR:
            out.append(a)
        if (a[2] >= NEAR) != (b[2] >= NEAR):
            out.append(a + (NEAR - a[2]) / (b[2] - a[2]) * (b - a))
    return np.array(out)


def render(faces, T_wc):
    """8-bit BGR image of the scene from camera pose T_wc (camera to world, OpenCV camera axes)."""
    Rcw = T_wc[:3, :3].T
    tcw = -Rcw @ T_wc[:3, 3]
    img = np.zeros((H, W, 3), np.uint8)
    zbuf = np.zeros((H, W), np.float32)
    for o, u, v, n, tex in faces:
        oc, uc, vc, nc = Rcw @ o + tcw, Rcw @ u, Rcw @ v, Rcw @ n
        d = nc @ oc
        if d >= 0:  # back face
            continue
        poly = _clip_near(np.array([oc, oc + uc, oc + uc + vc, oc + vc]))
        if len(poly) < 3:
            continue
        p = poly @ K.T
        p = p[:, :2] / p[:, 2:]
        x0, y0 = np.maximum(np.floor(p.min(0)).astype(int), 0)
        x1, y1 = np.minimum(np.ceil(p.max(0)).astype(int), (W, H))
        if x0 >= x1 or y0 >= y1:
            continue
        th, tw = tex.shape[:2]
        hom = np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]]) @ K @ np.column_stack([uc / tw, vc / th, oc])
        warped = cv2.warpPerspective(tex, hom, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillPoly(mask, [np.round((p - (x0, y0)) * 16).astype(np.int32)], 1, shift=4)
        invz = RAYS[y0:y1, x0:x1] @ (nc / d).astype(np.float32)
        zb = zbuf[y0:y1, x0:x1]
        m = (mask > 0) & (invz > zb)
        zb[m] = invz[m]
        img[y0:y1, x0:x1][m] = warped[m]
    return img


def capture(img, rng, light=1.0, gradient=0.0, tint=(1.0, 1.0, 1.0), blur_px=0.0, occluder=False):
    """iPhone-like capture of a render: lighting, occluder, motion blur, sensor noise, auto exposure."""
    x = img.astype(np.float32) / 255
    if occluder:  # something in the way: a person, a chair, a bag (15-35 percent of the frame)
        w, h = int(W * rng.uniform(0.3, 0.5)), int(H * rng.uniform(0.4, 0.7))
        x0, y0 = int(rng.integers(0, W - w)), int(rng.integers(0, H - h))
        blob = rng.uniform(0.05, 0.4, 3).astype(np.float32) + rng.normal(0, 0.02, (h, w, 1)).astype(np.float32)
        x[y0 : y0 + h, x0 : x0 + w] = blob
    a = rng.uniform(0, 2 * np.pi)
    ramp = np.cos(a) * (_u / W - 0.5) + np.sin(a) * (_v / H - 0.5)
    x *= (np.clip(1 + 2 * gradient * ramp, 0.05, None) * light)[..., None] * np.asarray(tint, np.float32)
    if blur_px >= 1:
        k = int(np.ceil(blur_px)) | 1
        kernel = np.zeros((k, k), np.float32)
        a = rng.uniform(0, np.pi)
        dx, dy = np.cos(a) * blur_px / 2, np.sin(a) * blur_px / 2
        c = k // 2
        cv2.line(kernel, (round(c - dx), round(c - dy)), (round(c + dx), round(c + dy)), 1.0, 1)
        x = cv2.filter2D(x, -1, kernel / kernel.sum())
    x = np.maximum(x, 0)
    x += rng.normal(0, 1, x.shape).astype(np.float32) * np.sqrt(x / 2000 + 1e-5)  # shot + read noise
    gain = np.clip(0.45 / max(float(x.mean()), 1e-3), 0.5, 8.0)  # auto exposure amplifies the noise too
    return (np.clip(x * gain, 0, 1) * 255).astype(np.uint8)
