# AR simulation procedures

These procedures tell you how to run the AR pin simulation in `tools/ar-sim/`, how to read its results, and how to add a scenario. The [overview](README.md) tells you what the simulation proves. The [real-device checks](real-device.md) tell you how to confirm each scenario on a real iPhone.

## Set up

Use Python 3.12 on Linux or macOS. No GPU is necessary.

```sh
uv venv -p 3.12 tools/ar-sim/.venv   # or: python3.12 -m venv tools/ar-sim/.venv
uv pip install -p tools/ar-sim/.venv -r tools/ar-sim/requirements.txt
```

The commands below use `py` for `tools/ar-sim/.venv/bin/python`.

## Quick CI job

The `ar-sim` workflow (`.github/workflows/ar-sim.yml`) runs two jobs in parallel on the `HEALTH_RUNNER`. Each job takes less than 3 minutes. Run the same commands locally:

```sh
py tools/ar-sim/run.py --quick                          # job "sim": 24 single-object trials (about 2 minutes on 4 cores)
py tools/ar-sim/multi.py --quick --map-without-drift    # job "multi": 4 rooms with 20 pinned containers (about 1.5 minutes on 4 cores)
py tools/ar-sim/usual.py                                # job "multi": usual-place learning (about 10 seconds)
```

The `multi` job gates the drift-free map: it tests the app's pipeline (pin, relocalization, marker rule, arrows) without the VIO drift that a map without global optimisation keeps. The drift runs fail the bar at 10 and 20 containers; the [overview](README.md#many-containers-in-one-room) gives the results and the reason.

Each command exits with 1 when its gate fails. The workflow adds the results tables to the job summary.

## Full sweep

Run the full sweep before you change the results in the [overview](README.md), and after any change to the scene, the camera model, the pairing behavior, or the pin method.

```sh
py tools/ar-sim/run.py                          # 50 baseline trials and 20 trials for each failure case (about 5 minutes on 8 cores)
py tools/ar-sim/multi.py                        # 8 rooms for each N in 1, 3, 5, 10, 20: LiDAR-depth pins, VIO drift (about 5 minutes on 16 cores)
py tools/ar-sim/multi.py --map-without-drift    # the same rooms on a map without VIO drift (the CI gate, for all N)
py tools/ar-sim/multi.py --pin points           # the same rooms with the map-point hit test (iPhones without LiDAR)
py tools/ar-sim/usual.py                        # 600 containers over 30 days
```

The three `multi.py` runs use the same random draws, so their rows compare the same rooms.

Use `--workers N` to set the number of processes and `--out DIR` to set the output folder (default `tools/ar-sim/out/`, which git ignores). Each trial or room uses a fixed seed, so two runs with the same pinned dependency versions give the same tables.

## Scenarios and pass criteria

| Scenario | Command | What it does | Pass criteria |
|---|---|---|---|
| Single object | `run.py`, case `baseline` | One medicine box on a cabinet. Session 1 scans and pins it. Session 2 starts at a new pose, in new light, with an occluder, and finds it. | Pairing completes in at least 95 percent of trials. The marker shows in at least 90 percent. Marker p95 error is at most 5 cm and at most 20 px. |
| Pairing, arrow, marker loop | every `run.py` trial | Pairing mode ("Turn slowly and look around the room", then "Walk closer"), then an arrow after the first fix, then the marker after a second fix that agrees within 5 cm. | Arrow p95 error is at most 15 degrees. No marker shows before two fixes agree. |
| Failure sweep | `run.py`, cases `short-scan`, `featureless-walls`, `big-lighting-change`, `far-start` | One change from the baseline in each case. | No pass bar. No marker may show at a wrong place. The table gives the guidance that the app must show. |
| Many objects | `multi.py`, N = 1, 3, 5, 10, 20 | N containers on a cabinet, a sofa, and a table, 10 to 30 cm apart, with look-alike boxes and tall boxes in front of some. One world map for the room. Session 1 pins each container from 0.6 to 0.9 m. Session 2 projects every anchor: markers on screen within 2 m, arrows nearest first for the others. Options: `--pin depth` (default, LiDAR) or `--pin points` (map points); `--map-without-drift`. | For each N: 0 wrong markers (no marker nearer another box, no swapped labels). Relocalized in at least 90 percent of rooms that have a pin. At least 90 percent of pinned boxes show a marker. Marker p95 error is at most 5 cm and at most 20 px. Arrow p95 error is at most 15 degrees. |
| Usual place | `usual.py` | Each container of each family member moves among 2 or 3 places for 30 days. The learner clusters that member's sightings (DBSCAN, 6 cm) with a recency weight (half-life 7 days). | Habit 70/25/5: top place right in at least 95 percent on day 30 and in at least 90 percent from day 14. When the line says "usually", it is right in at least 95 percent. Per-member learning beats a pooled family learner. |

`run.py --quick` gates only the baseline. `multi.py --quick` gates only N = 20, the hardest room. A full run prints PASS only when every row with a bar passes. In the current results, the full `run.py` passes; no full `multi.py` run passes every row (the drift runs fail at N = 10 and 20, and the drift-free run misses the relocalization rate at N = 1 and 3 by one room). The [overview](README.md#many-containers-in-one-room) gives the details.

## Read the results

Each command prints its tables and writes them to the output folder:

| File | Content |
|---|---|
| `results.md`, `results.json` | Single object and failure cases: one row for each case; the JSON also has each trial. |
| `multi-<pin>[-no-drift].md`, `.json` | Many objects: one row for each N in two tables (accuracy, then time and size); the JSON also has each room. For example `multi-depth.md` and `multi-depth-no-drift.md`. |
| `usual.md`, `usual.json` | Usual place: accuracy by day for each habit, the habit-change test, per member against pooled, example lines. |
| `<case>-<seed>.jpg`, `<case>-<seed>-arrow.jpg` | Single object: the marker frame and the first arrow frame of seeds 0 to 2. |
| `multi-<N>-markers.jpg`, `multi-<N>-arrows.jpg` | Many objects (default run only): the frame with the most markers, and the first frame with 3 or more arrows, for room 0 of each N. |

How to read the columns:

- **Error columns** compare the app's marker with the true point on the box. 3D error is in centimetres in the camera frame. Screen error is in pixels at 960 x 720 (half the ARKit frame size); "inf" means that a marker was on the screen while its box was behind the camera. "p95" is the 95th percentile. With many objects, each box counts once, with the worst error of all frames that showed its marker.
- **Pinned** (many objects) is the share of boxes with a pin: a box is not pinned when nothing gives a clear view of it within 50 degrees of its front, or when the LiDAR depth at the tap is an edge.
- **Pin error at save** (many objects) is the error of the pin itself, as the tap frame sees it, before any relocalization.
- **Wrong markers** count markers that are nearer another box than their own box, in 3D or on the screen (where the two boxes are at least 20 px apart). Two swapped labels count as two wrong markers. The column gives boxes that ever had a wrong marker, and wrong marker frames of all marker frames.
- **Marker on a hidden box** is the share of marker frames in which something blocks the camera's view of the box. ARKit draws the marker at the anchor anyway, so the marker shows the box behind the thing in front.
- **Time** columns count 0.5 s for each frame (pairing turns 15 degrees a frame at about 30 degrees per second).
- **Arrow error** is the angle between the view ray to the app's guess and the view ray to the true box, for every frame that shows an arrow.
- **Map KB** is the zlib-compressed world map with every anchor in it. "N copies of the map" is what the storage contract stores today, because it keeps one world map per container.

In the frames, a green ring is a marker, a red cross is the true point, and a yellow arrow points to a box that has no marker (numbered nearest first, thickest for the nearest; it ends at the box when the box is on the screen but farther than 2 m). The frames do not show the occluder, so you can see the boxes.

## Add a scenario

1. **Single-object failure case.** Add an entry to `CASES` in `tools/ar-sim/run.py`. An entry overrides keys of `BASE`, for example `"dim-and-far": {"light": (0.2, 0.3), "find_r": (3.0, 4.0)}`. The full run picks it up. Do not add it to the quick run.
2. **Scene change.** Change `make_scene` (single object) or `make_multi_scene` (many objects) in `tools/ar-sim/render.py`. A change to the random draws changes every seeded trial, so run the full sweep again.
3. **Many-object size.** Add the value to `NS` in `tools/ar-sim/multi.py`.
4. **Usual-place habit.** Add an entry to `HABITS` in `tools/ar-sim/usual.py`, for example `"80/20": (0.8, 0.2)`. The rest of the probability is a random spot.
5. Run the full sweep. Copy the new rows into the [overview](README.md), and copy frames that show the change from `tools/ar-sim/out/` to `tools/ar-sim/evidence/`.
6. Add the matching real-iPhone check to [real-device.md](real-device.md).
7. If the scenario must gate CI, give it a pass bar in the script (`PASS`) and keep each CI job under 3 minutes.
