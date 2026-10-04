"""River training entry point for the Gemma health-cue model.

    python train.py validate DATASET [--tokenizer NAME]    local, free
    python train.py check --base-model MODEL                 free River access check
    python train.py train DATASET --base-model MODEL --name NAME --confirm-paid
    python train.py deploy --checkpoint river://... --confirm-paid

The prompt and output format comes from packages/contracts/src/cue-format.json, the same file the
server sends to the deployment. Paid commands refuse to run without --confirm-paid. See
training/README.md.
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


def fail(message):
    sys.exit(f"train.py: {message}")


def render_user(readings):
    """Byte-identical to renderCueInput in apps/server/src/integrations/gemma.ts."""
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


def messages(example):
    """System and user turns, plus the assistant reply the model must learn."""
    prompt = [
        {"role": "system", "content": FORMAT["system"]},
        {"role": "user", "content": render_user(example["readings"])},
    ]
    reply = json.dumps(example["cue"], separators=(",", ":"), ensure_ascii=False)
    return prompt, reply


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


def check_example(example, where):
    if not isinstance(example, dict) or set(example) != {"readings", "cue"}:
        fail(f"{where}: expected exactly the keys readings and cue")
    readings = example["readings"]
    if not isinstance(readings, list) or not 1 <= len(readings) <= FORMAT["maxReadings"]:
        fail(f"{where}: readings must hold 1 to {FORMAT['maxReadings']} items")
    for reading in readings:
        check_reading(reading, where)
    check_cue(example["cue"], where)


def load_dataset(path):
    """Strictly validated JSONL examples and the file's sha256."""
    raw = Path(path).read_bytes()
    examples = []
    for number, line in enumerate(raw.decode().splitlines(), 1):
        if not line.strip():
            continue
        try:
            example = json.loads(line)
        except json.JSONDecodeError:
            fail(f"{path}:{number}: not valid JSON")
        check_example(example, f"{path}:{number}")
        examples.append(example)
    if not examples:
        fail(f"{path}: no examples")
    return examples, hashlib.sha256(raw).hexdigest()


def datum(tokenizer, example):
    """Token ids with the loss on the assistant reply only (next-token targets, offset by one)."""
    prompt, reply = messages(example)
    prompt_ids = tokenizer.apply_chat_template(prompt, add_generation_prompt=True, return_dict=False)
    full_ids = tokenizer.apply_chat_template(
        prompt + [{"role": "assistant", "content": reply}], return_dict=False,
    )
    if full_ids[: len(prompt_ids)] != prompt_ids:
        fail("the chat template does not extend the prompt with the reply; cannot mask the prompt")
    completion = len(full_ids) - len(prompt_ids)
    return {
        "input_ids": full_ids,
        "target_tokens": full_ids[1:] + [tokenizer.eos_token_id],
        "weights": [0.0] * (len(prompt_ids) - 1) + [1.0] * completion + [0.0],
    }


def require_paid(args):
    if not args.confirm_paid:
        fail("this command uses paid River capacity; rerun with --confirm-paid after the owner approves the cost")


def river_client():
    try:
        import river_client as river
    except ImportError:
        fail("river-client is not installed; run: pip install -r training/gemma/requirements.txt")
    key = os.environ.get("RIVER_API_KEY")
    if not key:
        fail("RIVER_API_KEY is not set; create your own key in the River Console (see training/README.md)")
    return river, river.Client(api_key=key, endpoint=os.environ.get("RIVER_ENDPOINT", "api.river.ai"))


def require_model(client, base_model):
    available = client.get_capabilities()
    if base_model not in available:
        fail(f"{base_model} is not enabled for this River key; enabled: {', '.join(available) or 'none'}")


def cmd_validate(args):
    examples, digest = load_dataset(args.dataset)
    example = FORMAT["example"]
    if render_user(example["readings"]) != example["user"]:
        fail("render_user no longer matches cue-format.json; the server and training would disagree")
    kinds = {k: sum(e["cue"]["kind"] == k for e in examples) for k in FORMAT["kinds"]}
    report = {"format": FORMAT["version"], "examples": len(examples), "kinds": kinds, "sha256": digest}
    if args.tokenizer:
        from transformers import AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained(args.tokenizer)
        data = [datum(tokenizer, e) for e in examples]
        report["tokenizer"] = args.tokenizer
        report["maxTokens"] = max(len(d["input_ids"]) for d in data)
        report["trainedTokens"] = int(sum(sum(d["weights"]) for d in data))
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
    examples, digest = load_dataset(args.dataset)
    river, client = river_client()
    with closing(client):
        require_model(client, args.base_model)
        tokenizer = river.load_tokenizer(base_model=args.base_model)
        data = [datum(tokenizer, e) for e in examples]
        with client.session(project="telly-health-cue") as session:
            model = session.create_model(
                base_model=args.base_model,
                lora=river.LoraConfig(rank=args.rank, seed=args.seed),
            )
            losses = []
            for step in range(args.steps):
                start = (step * args.batch_size) % len(data)
                batch = (data + data)[start : start + min(args.batch_size, len(data))]
                result = model.forward_backward(batch, loss_fn="cross_entropy")
                model.optim_step(lr=args.lr, grad_clip_norm=1.0)
                losses.append(result.metrics["loss"])
                print(f"step {step + 1}/{args.steps} loss={losses[-1]:.4f}", flush=True)
            checkpoint = model.save_weights(args.name, mode="inference")
            manifest = {
                "name": args.name,
                "format": FORMAT["version"],
                "baseModel": args.base_model,
                "checkpoint": checkpoint.path,
                "trainingRunId": model.training_run_id,
                "dataset": {"path": str(args.dataset), "sha256": digest, "examples": len(examples)},
                "lora": {"rank": args.rank, "seed": args.seed},
                "steps": args.steps,
                "batchSize": args.batch_size,
                "lr": args.lr,
                "losses": losses,
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
    print("Set these on the server (RIVER_API_KEY too, from your secret store):")
    print(f"GEMMA_BASE_URL={deployment.base_url}")
    print(f"GEMMA_DEPLOYMENT={deployment.model}")
    print(f"GEMMA_CHECKPOINT={deployment.checkpoint}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate", help="validate a JSONL dataset locally")
    validate.add_argument("dataset", type=Path)
    validate.add_argument("--tokenizer", help="Hugging Face tokenizer to build masked training data with")
    check = sub.add_parser("check", help="check River access and base-model availability")
    check.add_argument("--base-model", required=True)
    train = sub.add_parser("train", help="train a LoRA on River (paid)")
    train.add_argument("dataset", type=Path)
    train.add_argument("--base-model", required=True)
    train.add_argument("--name", required=True, help="checkpoint name, e.g. health-cue-v1-2026-10-04")
    train.add_argument("--steps", type=int, default=30)
    train.add_argument("--batch-size", type=int, default=16)
    train.add_argument("--lr", type=float, default=2e-4)
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
