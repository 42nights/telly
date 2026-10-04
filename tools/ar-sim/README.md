# AR pin simulation

A headless 3D simulation of the Telly AR medicine pin. It tests the save, relocalize, and project pipeline on Linux, because ARKit does not run in the iOS Simulator. It supports the medicine finder in the [plan](../../docs/plan.md#product).

- [Overview](../../docs/ar-sim/README.md): what the simulation proves and does not prove, how it maps to ARKit on a real iPhone, and the results.
- [Procedures](../../docs/ar-sim/procedures.md): commands, scenarios, pass criteria, how to read the results, how to add a scenario.
- [Real-device checks](../../docs/ar-sim/real-device.md): the matching real-iPhone check for each scenario.

```sh
uv venv -p 3.12 tools/ar-sim/.venv && uv pip install -p tools/ar-sim/.venv -r tools/ar-sim/requirements.txt
tools/ar-sim/.venv/bin/python tools/ar-sim/run.py --quick     # one container per room (CI job "sim")
tools/ar-sim/.venv/bin/python tools/ar-sim/multi.py --quick   # 20 containers per room (CI job "multi")
tools/ar-sim/.venv/bin/python tools/ar-sim/usual.py           # usual place from 30 days of sightings (CI job "multi")
```

| File | Content |
|---|---|
| `render.py` | Scenes (one container, or many on three pieces of furniture), the renderer, and the iPhone-like camera model. |
| `run.py` | One container: save, pairing, arrow, marker, and the failure cases. |
| `multi.py` | Many containers in one room with one world map. |
| `usual.py` | Usual-place learning from each member's sightings. |
| `evidence/` | Frames from the full runs, used in the overview. |
