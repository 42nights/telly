"""Build the Telly Qwen LoRA training data in training/qwen/data/.

Deterministic and rerunnable: seeded synthetic cues plus a small, fixed slice of
two permissively licensed public Hugging Face datasets, converted to the chat
format that train.py accepts. Writes cues.jsonl, mix.jsonl, train.jsonl,
images/*.jpg and manifest.json.

    training/qwen/.venv/bin/python training/qwen/datasets.py
"""

import hashlib
import io
import json
import random
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
IMAGES = DATA / "images"
CUE_FORMAT = json.loads((ROOT.parents[1] / "packages/contracts/src/cue-format.json").read_text())
ROWS_API = "https://datasets-server.huggingface.co"
SEED = 20261004
MAX_SIDE = 448

FOOD = "bharat-raghunathan/indian-foods-dataset"
DOLLY = "databricks/databricks-dolly-15k"
FOOD_NAMES = {"cholebhature": "Chole bhature", "kathiroll": "Kathi roll", "panipuri": "Pani puri",
              "pavbhaji": "Pav bhaji", "vadapav": "Vada pav"}
FOOD_QUESTION = "What food is in this photo? Answer in a few words."
DOLLY_CATEGORIES = {"open_qa", "general_qa", "brainstorming", "creative_writing"}

TEXTS = {
    "walk": ["You have been sitting for a while. A short walk around the room may feel good.",
             "How about a few steps? A slow walk to the window and back is a nice start.",
             "A short stroll could feel good now. Take your time.",
             "Maybe stretch your legs with a little walk around the house.",
             "A gentle walk outside or in the hallway might be pleasant now."],
    "hydrate": ["Time for a glass of water.",
                "A few sips of water would be good now.",
                "How about a drink of water? Keep a glass close by.",
                "Please pour yourself some water and take a few sips.",
                "Your water glass is waiting. A drink now may feel refreshing."],
    "rest": ["You slept less last night. A quiet rest this afternoon may help you feel good.",
             "Take a calm break. Sit somewhere comfortable for a few minutes.",
             "A short rest with your feet up could be nice now.",
             "Maybe lie down for a little while and relax.",
             "Slow down for a moment. A quiet rest may feel good."],
    "none": ["No cue right now.", "Nothing to suggest right now.", "No cue for now."],
}


def reading(rng, metric, value, unit, base):
    t = base + timedelta(minutes=rng.randrange(0, 120, 5))
    return {"metric": metric, "value": value, "unit": unit, "sourceTime": t.strftime("%Y-%m-%dT%H:%M:%S.000000Z")}


def normal(rng, metric):
    return {
        "steps": (rng.randint(3500, 9000), "count"),
        "heart_rate": (round(rng.uniform(60, 82), 1) if rng.random() < 0.5 else rng.randint(60, 82), "bpm"),
        "water_intake": (rng.randrange(1200, 2200, 50), "ml"),
        "sleep_duration": (round(rng.uniform(6.8, 8.5), 1), "h"),
    }[metric]


def low(rng, metric):
    return {
        "steps": (rng.randint(80, 900), "count"),
        "water_intake": (rng.randrange(0, 500, 50), "ml"),
        "sleep_duration": (round(rng.uniform(3.5, 5.4), 1), "h"),
    }[metric]


def synth_cues(n=240):
    rng = random.Random(SEED)
    trigger = {"walk": "steps", "hydrate": "water_intake", "rest": "sleep_duration"}
    out = []
    for i in range(n):
        kind = CUE_FORMAT["kinds"][i % 4]
        base = datetime(2026, 10, 1 + rng.randrange(7), rng.randint(8, 18), tzinfo=timezone.utc)
        others = [m for m in ("steps", "heart_rate", "water_intake", "sleep_duration") if m != trigger.get(kind)]
        metrics = rng.sample(others, rng.randint(0 if kind != "none" else 1, 3))
        readings = [reading(rng, m, *normal(rng, m), base) for m in metrics]
        if kind in trigger:
            readings.append(reading(rng, trigger[kind], *low(rng, trigger[kind]), base))
        readings.sort(key=lambda r: r["sourceTime"])
        out.append({"readings": readings, "cue": {"kind": kind, "text": rng.choice(TEXTS[kind])}})
    return out


def get(url, **params):
    for attempt in range(4):
        r = requests.get(url, params=params, timeout=60)
        if r.status_code < 500 and r.status_code != 429:
            r.raise_for_status()
            return r
        time.sleep(2 ** attempt)
    r.raise_for_status()


def rows(dataset, offset, length, split="train"):
    return get(f"{ROWS_API}/rows", dataset=dataset, config="default", split=split, offset=offset, length=length).json()


def source_info(dataset, split="train"):
    info = get(f"{ROWS_API}/info", dataset=dataset).json()["dataset_info"]["default"]
    sha = get(f"https://huggingface.co/api/datasets/{dataset}").json()["sha"]
    return info["splits"][split]["num_examples"], sha


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def food_examples(total):
    # 20 chunks of 5 rows spread over the split, so every class shows up.
    examples, files = [], {}
    for k in range(20):
        page = rows(FOOD, k * (total // 20), 5)
        names = page["features"][1]["type"]["names"]
        for row in page["rows"]:
            label = names[row["row"]["label"]]
            img = Image.open(io.BytesIO(get(row["row"]["image"]["src"]).content)).convert("RGB")
            img.thumbnail((MAX_SIDE, MAX_SIDE))
            path = IMAGES / f"indian-foods-{row['row_idx']:05d}.jpg"
            img.save(path, "JPEG", quality=85)
            rel = path.relative_to(DATA).as_posix()
            files[rel] = sha256(path)
            examples.append({"messages": [{"role": "user", "content": FOOD_QUESTION},
                                          {"role": "assistant", "content": FOOD_NAMES.get(label, label.capitalize())}],
                             "image": rel})
    return examples, files


def dolly_examples(limit=100):
    examples, offset = [], 0
    while len(examples) < limit:
        for row in rows(DOLLY, offset, 100)["rows"]:
            r = row["row"]
            if r["category"] in DOLLY_CATEGORIES and not r["context"].strip() and len(r["response"]) <= 400:
                examples.append({"messages": [{"role": "user", "content": r["instruction"].strip()},
                                              {"role": "assistant", "content": r["response"].strip()}]})
        offset += 100
    return examples[:limit]


def write_jsonl(path, items):
    path.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in items))
    return sha256(path)


def main():
    shutil.rmtree(IMAGES, ignore_errors=True)
    IMAGES.mkdir(parents=True)

    cues = synth_cues()
    for c in cues:
        assert c["cue"]["kind"] in CUE_FORMAT["kinds"] and len(c["cue"]["text"]) <= CUE_FORMAT["maxTextLength"]
        assert 0 < len(c["readings"]) <= CUE_FORMAT["maxReadings"]

    food_total, food_sha = source_info(FOOD)
    food, food_files = food_examples(food_total)
    dolly_total, dolly_sha = source_info(DOLLY)
    dolly = dolly_examples()

    mix = food + dolly
    train = cues + mix
    random.Random(SEED).shuffle(train)
    files = {"cues.jsonl": write_jsonl(DATA / "cues.jsonl", cues),
             "mix.jsonl": write_jsonl(DATA / "mix.jsonl", mix),
             "train.jsonl": write_jsonl(DATA / "train.jsonl", train)}

    manifest = {
        "seed": SEED,
        "datasets": [
            {"name": "telly-synthetic-cues", "source": "training/qwen/datasets.py synth_cues() (seeded)",
             "license": "project-owned synthetic data", "license_evidence": "generated locally, no personal data",
             "rows_used": len(cues), "source_rows": len(cues), "files": {"cues.jsonl": files["cues.jsonl"]}},
            {"name": FOOD, "source": f"https://huggingface.co/datasets/{FOOD}", "revision": food_sha,
             "license": "cc0-1.0", "license_evidence": f"https://huggingface.co/datasets/{FOOD}/blob/main/README.md (license: cc0-1.0)",
             "rows_used": len(food), "source_rows": food_total, "files": food_files},
            {"name": DOLLY, "source": f"https://huggingface.co/datasets/{DOLLY}", "revision": dolly_sha,
             "license": "cc-by-sa-3.0", "license_evidence": f"https://huggingface.co/datasets/{DOLLY}/blob/main/README.md (license: cc-by-sa-3.0)",
             "rows_used": len(dolly), "source_rows": dolly_total, "files": {"mix.jsonl": files["mix.jsonl"]}},
        ],
        "files": files,
        "counts": {"cues": len(cues), "food": len(food), "dolly": len(dolly), "mix": len(mix), "train": len(train)},
    }
    (DATA / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for d in manifest["datasets"]:
        print(f"{d['name']}\t{d['source']}\t{d['license']}\t{d['rows_used']}/{d['source_rows']}")
    print(json.dumps(manifest["counts"]), json.dumps(files))


if __name__ == "__main__":
    main()
