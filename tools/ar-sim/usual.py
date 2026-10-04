#!/usr/bin/env python3
"""Telly usual place: learn where each family member usually keeps each container from AR sightings.

Each container of each member moves among 2 or 3 real places with fixed probabilities, and lands
somewhere in a random spot 5 percent of the time. A sighting is a pinned position in one room's world
map (positions from different rooms are never compared), with the place text the person confirmed.
The learner clusters one member's sightings of one container (DBSCAN, 6 cm radius), scores each
cluster by recency-weighted count (half-life 7 days), and names the top cluster by its most common
place text. Sightings stay per member: the key is (member, container).

    python tools/ar-sim/usual.py    # 30 simulated days; exit 1 below the bar (about 10 s)
"""

import argparse
import json
import os
import sys
from collections import Counter

import numpy as np

DAYS = 30
SEEN_PER_DAY = 0.8  # chance that the person looks the container up (or pins it) on a given day
SPOT_CM = 3.0  # where on the shelf it lands: standard deviation per axis
PIN_CM = 1.5  # AR pin error per axis (the multi-object run: median 1 to 2 cm)
EPS_M = 0.06  # DBSCAN radius
MIN_PTS = 2
HALF_LIFE = 7.0  # days
LAST = 10  # the wording counts the last 10 sightings
CORRECT_M = 0.10  # the top cluster is right when its centre is within 10 cm of the true usual place
PASS = {"clear_day30": 0.95, "clear_days_to_90": 14, "worded_precision": 0.95}
# (room, place text, position in that room's world map, metres)
PLACES = [
    ("bathroom", "bathroom shelf", (0.3, 1.2, 1.4)), ("bathroom", "bathroom sink", (1.0, 0.4, 0.9)),
    ("kitchen", "kitchen counter", (2.0, 0.5, 0.92)), ("kitchen", "kitchen table", (1.2, 2.0, 0.75)),
    ("kitchen", "top of the fridge", (0.4, 0.4, 1.8)), ("bedroom", "nightstand", (0.5, 2.5, 0.6)),
    ("bedroom", "dresser", (2.8, 0.3, 1.0)), ("living room", "cabinet", (4.6, 1.5, 0.85)),
    ("living room", "coffee table", (2.2, 1.9, 0.45)),
]
ROOM_BOX = (5.0, 4.0, 2.0)  # random spots: anywhere in a room this size
HABITS = {"70/25/5": (0.70, 0.25), "55/25/15/5": (0.55, 0.25, 0.15), "50/45/5": (0.50, 0.45)}  # the rest is random


def dbscan(X, eps, min_pts):
    """Cluster labels for points X (n, 3): -1 for noise. Plain DBSCAN, O(n^2), fine for 30 days."""
    near = np.linalg.norm(X[:, None] - X[None], axis=2) <= eps
    core = near.sum(1) >= min_pts
    labels, c = np.full(len(X), -1), 0
    for i in np.flatnonzero(core):
        if labels[i] != -1:
            continue
        labels[i], stack = c, [i]
        while stack:
            j = stack.pop()
            if core[j]:
                for k in np.flatnonzero(near[j] & (labels == -1)):
                    labels[k] = c
                    stack.append(k)
        c += 1
    return labels


def usual_place(sightings, today, half_life=HALF_LIFE):
    """The usual place from one member's sightings of one container, or None.

    sightings: list of (day, room, position, place text). Returns (places, wording): places is the top
    place, or the top two when the wording names two, each (room, centre, place text). The wording is
    None when the last sightings do not support "usually"; the app then shows the last sighting."""
    ranked = []
    for room in sorted({s[1] for s in sightings}):
        idx = [i for i, s in enumerate(sightings) if s[1] == room]
        X = np.array([sightings[i][2] for i in idx])
        w = 0.5 ** ((today - np.array([sightings[i][0] for i in idx])) / half_life)
        labels = dbscan(X, EPS_M, MIN_PTS)
        for c in set(labels.tolist()) - {-1}:
            members = {idx[i] for i in np.flatnonzero(labels == c)}
            name = Counter(sightings[i][3] for i in members).most_common(1)[0][0]
            ranked.append((w[labels == c].sum(), (room, X[labels == c].mean(0), name), members))
    if not ranked:
        return None
    ranked.sort(key=lambda p: -p[0])
    last = sorted(range(len(sightings)), key=lambda i: sightings[i][0])[-LAST:]
    n, (k1, k2) = len(last), [sum(i in p[2] for i in last) for p in (ranked + [(0, None, set())])[:2]]
    if n >= 5 and len(ranked[0][2]) >= 3 and k1 >= 0.6 * n and k2 <= 0.25 * n:
        return [ranked[0][1]], f"usually on the {ranked[0][1][2]}, {k1} of the last {n} times"
    if n >= 5 and k2 >= 2 and k1 + k2 >= 0.6 * n:  # a close second place: name both
        return [ranked[0][1], ranked[1][1]], (f"usually on the {ranked[0][1][2]} or the {ranked[1][1][2]},"
                                              f" {k1} and {k2} of the last {n} times")
    return [ranked[0][1]], None


def simulate(rng, probs, days=DAYS, change_day=None):
    """One container's sightings over `days`. Returns (sightings, places, usual index per day)."""
    places = [PLACES[i] for i in rng.choice(len(PLACES), len(probs), replace=False)]
    out, usual = [], []
    for day in range(1, days + 1):
        p = np.array(probs if change_day is None or day < change_day else (probs[1], probs[0], *probs[2:]))
        usual.append(int(p.argmax()))
        if rng.random() >= SEEN_PER_DAY:
            continue
        r = rng.random()
        if r < p.sum():
            room, text, pos = places[int(np.searchsorted(np.cumsum(p), r, side="right"))]
            pos = np.asarray(pos) + np.append(rng.normal(0, SPOT_CM / 100, 2), 0)
        else:  # somewhere else: a random spot in one of the rooms, named loosely
            room, text, pos = PLACES[int(rng.integers(len(PLACES)))][0], "somewhere else", rng.uniform(0, ROOM_BOX, 3)
        out.append((day, room, pos + rng.normal(0, PIN_CM / 100, 3), text))
    return out, places, usual


def correct(guess, places, usual_i, named=False):
    """True when the top place (or, with named=True, any place the wording names) is the usual place."""
    room, _, pos = places[usual_i]
    return guess is not None and any(g[0] == room and np.linalg.norm(g[1] - np.asarray(pos)) <= CORRECT_M
                                     for g in (guess[0] if named else guess[0][:1]))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--families", type=int, default=100, help="families, each with 2 members and 3 containers per member")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(7)
    names = ["Vitamin D", "Metformin", "Lisinopril", "Aspirin", "Eye drops", "Inhaler"]

    # Sightings stay per member: the key is (family, member, container name). Two members can keep a
    # container with the same name in different places; each gets their own usual place.
    habits = list(HABITS)
    store, truth = {}, {}
    for f in range(a.families):
        for member in ("member-a", "member-b"):
            for c, name in enumerate(rng.choice(names, 3, replace=False)):
                habit = habits[(f * 6 + (member == "member-b") * 3 + c) % len(habits)]
                sightings, places, usual = simulate(rng, HABITS[habit])
                store[(f, member, str(name))], truth[(f, member, str(name))] = sightings, (habit, places, usual)
    shared = [(f, n) for f in range(a.families) for n in names if (f, "member-a", n) in store and (f, "member-b", n) in store]

    rows, examples = {}, []
    for habit in habits:
        keys = [k for k in store if truth[k][0] == habit]
        acc, worded, worded_ok = [], 0, 0
        for day in range(1, DAYS + 1):
            ok = 0
            for k in keys:
                S = [s for s in store[k] if s[0] <= day]
                g = usual_place(S, day) if S else None
                ok += correct(g, truth[k][1], truth[k][2][day - 1])
                if day == DAYS and g is not None and g[1]:
                    worded += 1
                    worded_ok += correct(g, truth[k][1], truth[k][2][day - 1], named=True)
                    if (len(examples) < 3 and habit == habits[0]) or (len(examples) == 3 and len(g[0]) == 2):
                        examples.append(f"{k[1]}, {k[2]} ({habit}): \"{g[1]}\"")
            acc.append(ok / len(keys))
        days_to_90 = next((d + 1 for d in range(DAYS) if min(acc[d:]) >= 0.9), None)
        rows[habit] = {"containers": len(keys), "acc": acc, "days_to_90": days_to_90,
                       "worded": worded / len(keys), "worded_precision": worded_ok / max(worded, 1)}

    # Habit change: on day 15 the second place becomes the usual one. Days until the learner follows.
    adapt = {}
    for label, hl in (("half-life 7 days", HALF_LIFE), ("no recency weight", np.inf)):
        r2, lag = np.random.default_rng(11), []
        for _ in range(100):
            sightings, places, _ = simulate(r2, HABITS["70/25/5"], change_day=15)
            lag.append(next((d - 15 for d in range(15, DAYS + 1)
                             if correct(usual_place([s for s in sightings if s[0] <= d], d, hl), places, 1)), None))
        got = [x for x in lag if x is not None]
        adapt[label] = {"followed_by_day_30": len(got) / len(lag), "days_median": float(np.median(got)) if got else float("nan")}

    # Sightings stay per member. Pooling a family's sightings of a same-name container (two members,
    # each with their own bottle of Vitamin D) would answer with the other member's place.
    def right(sightings, k):
        return correct(usual_place(sightings, DAYS), truth[k][1], truth[k][2][-1])
    pairs = [((f, "member-a", n), (f, "member-b", n)) for f, n in shared]
    per_member = sum(right(store[k], k) for p in pairs for k in p) / (2 * len(pairs))
    pooled = sum(right(store[p[0]] + store[p[1]], k) for p in pairs for k in p) / (2 * len(pairs))

    lines = ["| habit (usual / second / third / random %) | containers | top place right, day 3 / 7 / 14 / 30 | days to 90% | \"usually\" wording shown on day 30 | wording right |",
             "|---|---|---|---|---|---|"]
    for habit, r in rows.items():
        acc = r["acc"]
        lines.append(f"| {habit} | {r['containers']} | {acc[2]:.0%} / {acc[6]:.0%} / {acc[13]:.0%} / {acc[29]:.0%}"
                     f" | {r['days_to_90'] or 'not in 30'} | {r['worded']:.0%} | {r['worded_precision']:.0%} |")
    lines += ["", "| usual place moves on day 15 | followed by day 30 | days to follow (median) |", "|---|---|---|"]
    lines += [f"| {k} | {v['followed_by_day_30']:.0%} | {v['days_median']:.0f} |" for k, v in adapt.items()]
    lines += ["", f"Same container name kept by both members ({len(pairs)} pairs), day 30: top place right {per_member:.0%} per member,"
              f" {pooled:.0%} if the family's sightings were pooled."]
    lines += ["", "Examples (day 30):"] + [f"- {e}" for e in examples]
    worded_all = sum(r["worded"] * r["containers"] * r["worded_precision"] for r in rows.values()) / max(sum(r["worded"] * r["containers"] for r in rows.values()), 1)
    clear = rows["70/25/5"]
    passed = (clear["acc"][-1] >= PASS["clear_day30"] and (clear["days_to_90"] or 99) <= PASS["clear_days_to_90"]
              and worded_all >= PASS["worded_precision"] and per_member > pooled)
    table = "\n".join(lines)
    print(table)
    print(f"\nusual-place gate (70/25/5: day 30 >= 95% and 90% by day 14; \"usually\" wording right >= 95%;"
          f" per member beats pooled): {'PASS' if passed else 'FAIL'}")
    with open(os.path.join(a.out, "usual.json"), "w") as f:
        json.dump({"pass": bool(passed), "habits": rows, "habit_change": adapt, "per_member": per_member, "pooled": pooled}, f, indent=1)
    with open(os.path.join(a.out, "usual.md"), "w") as f:
        f.write(table + "\n")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
