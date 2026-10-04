"""River training entry point for the Qwen health-cue model (Qwen/Qwen3.5-9B, multimodal).

    python train.py validate DATASET [--base-model MODEL]   local, free
    python train.py check --base-model MODEL                 free River access check
    python train.py train DATASET --base-model MODEL --name NAME --confirm-paid
    python train.py deploy --checkpoint river://... --confirm-paid

The prompt and output format comes from packages/contracts/src/cue-format.json, the same file the
server sends to the deployment. Paid commands refuse to run without --confirm-paid. See
training/qwen/README.md.
"""

import argparse
import hashlib
import json
import math
import os
import sys
from contextlib import closing
from importlib import metadata
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORMAT = json.loads(
    (HERE.parents[1] / "packages/contracts/src/cue-format.json").read_text()
)
RUNS = HERE / "runs"
READING_KEYS = {"metric", "value", "unit", "sourceTime"}
DEFAULT_BASE_MODEL = "Qwen/Qwen3.5-9B"


def fail(message):
    sys.exit(f"train.py: {message}")


def render_user(readings):
    """Byte-identical to renderCueInput in apps/server/src/integrations/qwen.ts."""
    rows = [
        {
            "metric": r["metric"],
            # JSON.stringify writes 420.0 as 420; match it.
            "value": int(r["value"]) if float(r["value"]).is_integer() else r["value"],
            "unit": r["unit"],
            "sourceTime": r["sourceTime"],
        }
        for r in readings
    ]
    return json.dumps({"readings": rows}, separators=(",", ":"), ensure_ascii=False)


def check_reading(reading, where):
    if not isinstance(reading, dict) or set(reading) != READING_KEYS:
        fail(f"{where}: each reading has exactly {sorted(READING_KEYS)}")
    value = reading["value"]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail(f"{where}: reading value must be a finite number")
    if not all(isinstance(reading[k], str) and reading[k] for k in ("metric", "unit", "sourceTime")):
        fail(f"{where}: metric, unit, and sourceTime must be non-empty strings")


def check_cue(cue, where):
    if not isinstance(cue, dict) or set(cue) != {"kind", "text"}:
        fail(f"{where}: cue has exactly the keys kind and text")
    if cue["kind"] not in FORMAT["kinds"]:
        fail(f"{where}: cue kind must be one of {FORMAT['kinds']}")
    if not isinstance(cue["text"], str) or not 1 <= len(cue["text"]) <= FORMAT["maxTextLength"]:
        fail(f"{where}: cue text must hold 1 to {FORMAT['maxTextLength']} characters")


def check_cue_example(example, where):
    readings = example["readings"]
    if not isinstance(readings, list) or not 1 <= len(readings) <= FORMAT["maxReadings"]:
        fail(f"{where}: readings must hold 1 to {FORMAT['maxReadings']} items")
    for reading in readings:
        check_reading(reading, where)
    check_cue(example["cue"], where)


def check_chat_example(example, base, where):
    turns = example["messages"]
    if not isinstance(turns, list) or len(turns) < 2:
        fail(f"{where}: messages must hold at least a user and an assistant turn")
    for turn in turns:
        if not isinstance(turn, dict) or set(turn) != {"role", "content"}:
            fail(f"{where}: each message has exactly role and content")
        if turn["role"] not in ("system", "user", "assistant"):
            fail(f"{where}: message role must be system, user, or assistant")
        if not isinstance(turn["content"], str) or not turn["content"]:
            fail(f"{where}: message content must be a non-empty string")
    if turns[-1]["role"] != "assistant":
        fail(f"{where}: the last message is the assistant reply to learn")
    image = example.get("image")
    if image is not None and not (isinstance(image, str) and (base / image).is_file()):
        fail(f"{where}: image must be a path relative to the dataset that exists")


def check_example(example, base, where):
    if isinstance(example, dict) and set(example) == {"readings", "cue"}:
        check_cue_example(example, where)
    elif isinstance(example, dict) and set(example) in ({"messages"}, {"messages", "image"}):
        check_chat_example(example, base, where)
    else:
        fail(f"{where}: expected a cue example (readings, cue) or a chat example (messages, image?)")


def load_dataset(path):
    """Strictly validated JSONL examples and the file's sha256."""
    raw = Path(path).read_bytes()
    base = Path(path).resolve().parent
    examples = []
    for number, line in enumerate(raw.decode().splitlines(), 1):
        if not line.strip():
            continue
        try:
            example = json.loads(line)
        except json.JSONDecodeError:
            fail(f"{path}:{number}: not valid JSON")
        check_example(example, base, f"{path}:{number}")
        examples.append(example)
    if not examples:
        fail(f"{path}: no examples")
    return examples, base, hashlib.sha256(raw).hexdigest()


def messages(example, base):
    """The chat turns to train on; the last assistant turn carries the loss."""
    if "cue" in example:
        reply = json.dumps(example["cue"], separators=(",", ":"), ensure_ascii=False)
        return [
            {"role": "system", "content": FORMAT["system"]},
            {"role": "user", "content": render_user(example["readings"])},
            {"role": "assistant", "content": reply},
        ]
    turns = [dict(t) for t in example["messages"]]
    if "image" in example:
        from river_client.renderers import image_part

        data = (base / example["image"]).read_bytes()
        first = next(t for t in turns if t["role"] == "user")
        fmt = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpeg"
        first["content"] = [image_part(data, format=fmt), {"type": "text", "text": first["content"]}]
    return turns


def renderer_for(base_model):
    from river_client.renderers import get_renderer

    # The server asks with thinking off (chat_template_kwargs.enable_thinking=false); train the same way.
    return get_renderer(base_model, thinking=False)


def datum(renderer, example, base):
    from river_client.renderers import TrainOnWhat

    return renderer.build_training_example(
        messages(example, base), train_on=TrainOnWhat.LAST_ASSISTANT
    ).to_dict()


def require_paid(args):
    if not args.confirm_paid:
        fail("this command uses paid River capacity; rerun with --confirm-paid after the owner approves the cost")


def river_client():
    try:
        import river_client as river
    except ImportError:
        fail("river-client is not installed; run: pip install -r training/qwen/requirements.txt")
    key = os.environ.get("RIVER_API_KEY")
    if not key:
        fail("RIVER_API_KEY is not set; create your own key in the River Console (see training/qwen/README.md)")
    return river, river.Client(api_key=key, endpoint=os.environ.get("RIVER_ENDPOINT", "api.river.ai"))


def require_model(client, base_model):
    available = client.get_capabilities()
    if base_model not in available:
        fail(f"{base_model} is not enabled for this River key; enabled: {', '.join(available) or 'none'}")


def cmd_validate(args):
    examples, base, digest = load_dataset(args.dataset)
    example = FORMAT["example"]
    if render_user(example["readings"]) != example["user"]:
        fail("render_user no longer matches cue-format.json; the server and training would disagree")
    cues = [e for e in examples if "cue" in e]
    report = {
        "format": FORMAT["version"],
        "examples": len(examples),
        "cueKinds": {k: sum(e["cue"]["kind"] == k for e in cues) for k in FORMAT["kinds"]},
        "chat": len(examples) - len(cues),
        "images": sum("image" in e for e in examples),
        "sha256": digest,
    }
    if args.base_model:
        renderer = renderer_for(args.base_model)
        weights = [datum(renderer, e, base)["weights"] for e in examples]
        report["baseModel"] = args.base_model
        report["maxTokens"] = max(len(w) for w in weights)
        report["tokens"] = sum(len(w) for w in weights)
    print(json.dumps(report, indent=2))


def cmd_check(args):
    _, client = river_client()
    with closing(client):
        if not client.health_check():
            fail("River health check failed")
        require_model(client, args.base_model)
    print(f"River access ok; {args.base_model} is enabled for this key")


def cmd_train(args):
    require_paid(args)
    if (RUNS / f"{args.name}.json").exists():
        fail(f"runs/{args.name}.json exists; pick a new --name so every checkpoint stays traceable")
    examples, base, digest = load_dataset(args.dataset)
    renderer = renderer_for(args.base_model)
    data = [datum(renderer, e, base) for e in examples]
    river, client = river_client()
    with closing(client):
        require_model(client, args.base_model)
        with client.session(project="telly-health-cue", run=args.name) as session:
            model = session.create_model(
                base_model=args.base_model,
                lora=river.LoraConfig(rank=args.rank, seed=args.seed),
            )
            losses = []
            for step in range(args.steps):
                start = (step * args.batch_size) % len(data)
                batch = (data + data)[start : start + min(args.batch_size, len(data))]
                fb, _ = model.train_step(batch, lr=args.lr, loss_fn="cross_entropy", grad_clip_norm=1.0)
                losses.append(fb.metrics["loss_mean"])
                print(f"step {step + 1}/{args.steps} loss_mean={losses[-1]:.4f}", flush=True)
            checkpoint = model.save_weights(args.name, mode="inference")
            manifest = {
                "name": args.name,
                "format": FORMAT["version"],
                "baseModel": args.base_model,
                "checkpoint": checkpoint.path,
                "trainingRunId": model.training_run_id,
                "sessionId": session.session_id,
                "dataset": {"path": str(args.dataset), "sha256": digest, "examples": len(examples)},
                "lora": {"rank": args.rank, "seed": args.seed},
                "steps": args.steps,
                "batchSize": args.batch_size,
                "lr": args.lr,
                "lossesMean": losses,
                "riverClient": metadata.version("river-client"),
            }
    RUNS.mkdir(exist_ok=True)
    (RUNS / f"{args.name}.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


def cmd_deploy(args):
    require_paid(args)
    _, client = river_client()
    with closing(client):
        deployment = client.create_deployment(
            checkpoint=args.checkpoint,
            unified_replicas=1,
            idempotency_key=args.checkpoint,
            wait=True,
        )
    if not deployment.is_serving:
        fail(f"deployment {deployment.id} is {deployment.phase}: {deployment.phase_reason or 'no reason given'}")
    print(f"Deployment {deployment.id} is serving.")
    print("Set these on the server (RIVER_API_KEY too, from your secret store):")
    print(f"QWEN_BASE_URL={deployment.base_url}")
    print(f"QWEN_DEPLOYMENT={deployment.model}")
    print(f"QWEN_CHECKPOINT={deployment.checkpoint}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate", help="validate a JSONL dataset locally")
    validate.add_argument("dataset", type=Path)
    validate.add_argument("--base-model", help="also render masked training data with this model's renderer")
    check = sub.add_parser("check", help="check River access and base-model availability")
    check.add_argument("--base-model", default=DEFAULT_BASE_MODEL)
    train = sub.add_parser("train", help="train a LoRA on River (paid)")
    train.add_argument("dataset", type=Path)
    train.add_argument("--base-model", default=DEFAULT_BASE_MODEL)
    train.add_argument("--name", required=True, help="checkpoint name, e.g. health-cue-v1-2026-10-04")
    train.add_argument("--steps", type=int, default=30)
    train.add_argument("--batch-size", type=int, default=16)
    train.add_argument("--lr", type=float, default=1e-4)
    train.add_argument("--rank", type=int, default=16)
    train.add_argument("--seed", type=int, default=0)
    train.add_argument("--confirm-paid", action="store_true")
    deploy = sub.add_parser("deploy", help="serve a checkpoint on a River dedicated deployment (paid)")
    deploy.add_argument("--checkpoint", required=True)
    deploy.add_argument("--confirm-paid", action="store_true")
    args = parser.parse_args()
    {"validate": cmd_validate, "check": cmd_check, "train": cmd_train, "deploy": cmd_deploy}[args.command](args)


if __name__ == "__main__":
    main()
