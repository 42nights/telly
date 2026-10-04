# Qwen health-cue post-training on River

This folder trains and serves the model that turns validated health readings into one short cue, such as a walk reminder.
River AI runs the training and the inference. The model never runs on the glasses.
Plan: [`docs/board.html`](../../docs/board.html) (`sys-training`, `sys-models`). Issues: [#9](https://github.com/ayaangazali/telly/issues/9) (River access) and [#10](https://github.com/ayaangazali/telly/issues/10) (training and inference).

The base model is `Qwen/Qwen3.5-9B`, a multimodal (text and image) Qwen model. River does not offer Gemma for our key, so the captain chose Qwen.

## What is here

| Path | Purpose |
| --- | --- |
| `train.py` | The entry point: `validate`, `check`, `train`, `deploy` |
| `datasets.py` | Fetches and converts the training data into `data/` |
| `serve.py` | The versioned inference endpoint: an OpenAI-compatible bridge to one pinned checkpoint |
| `requirements.txt` | Pinned Python dependencies (`river-client` 0.12.0, `pillow` 12.3.0) |
| `fixtures/synthetic.jsonl` | Four synthetic cue examples. They prove the format only |
| `../../packages/contracts/src/cue-format.json` | The prompt and output format. Training and the server read this one file |

Git ignores `data/` (datasets and images), `runs/` (run manifests), audio and video recordings under `training/`, and model weight files. Do not commit training data, recordings, or weights.

## Set up

1. Get your own River account and API key from the **API Keys** page of the [River Console](https://console.river.ai/). Do not share a login or a key. Do not put a key in the repository or in an issue.
2. Install the dependencies and load the key from your secret store. Do not print the key.

```sh
cd training/qwen
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
export RIVER_API_KEY=...   # your own key, from your secret store
```

3. Check access (free). It prints whether `Qwen/Qwen3.5-9B` is enabled for your key:

```sh
.venv/bin/python train.py check
```

## Datasets

`datasets.py` builds all data. It is seeded and rerunnable. No dataset has real patient data or personal identifiers.

| Dataset | Source | License | Rows used | How it is converted |
| --- | --- | --- | --- | --- |
| Telly synthetic cues | `datasets.py` `synth_cues()`, seed 20261004 | Project-owned synthetic data | 240 (60 for each kind: walk, hydrate, rest, none) | Readings with one low trigger (`steps`, `water_intake`, or `sleep_duration`) and a matching cue, or only normal readings and `none` |
| `bharat-raghunathan/indian-foods-dataset` | https://huggingface.co/datasets/bharat-raghunathan/indian-foods-dataset | CC0-1.0 | 100 of 3809 (all 15 classes) | Image (resized to at most 448 px, JPEG) plus "What food is in this photo? Answer in a few words." The answer is the class name |
| `databricks/databricks-dolly-15k` | https://huggingface.co/datasets/databricks/databricks-dolly-15k | CC-BY-SA-3.0 | 100 of 15011 | `open_qa`, `general_qa`, `brainstorming`, and `creative_writing` rows with no context and a reply of at most 400 characters, as one user and one assistant turn |

Rejected: Food-101 (no license on the hub), FoodSense (participant id columns), and pill image sets (no clear license).
Rows come from the Hugging Face datasets-server rows API. `data/manifest.json` records each dataset's hub revision, license evidence, row counts, and the sha256 of each output file.

```sh
.venv/bin/python datasets.py                                         # writes data/cues.jsonl, mix.jsonl, train.jsonl, images/, manifest.json
.venv/bin/python train.py validate data/train.jsonl --base-model Qwen/Qwen3.5-9B
```

`train.jsonl` holds 440 examples (240 cues, 100 food images, 100 Dolly), 73,976 tokens, and 318 tokens at most per example.
Each JSONL line is one of:

- a cue example: `{"readings":[{"metric","value","unit","sourceTime"}],"cue":{"kind","text"}}`
- a chat example: `{"messages":[{"role","content"}],"image":"images/<file>.jpg"}`. `image` is optional and attaches to the first user turn.

`train.py` renders each example with the River renderer for the base model (`river_client.renderers.get_renderer`, thinking off). The loss covers only the last assistant reply.

## Train (paid)

```sh
.venv/bin/python train.py train data/train.jsonl --name health-cue-qwen35-9b-v1-2026-10-04 --confirm-paid
```

Settings: LoRA rank 16, seed 0, 30 steps, batch size 16, learning rate 1e-4, `cross_entropy` loss, gradient clip 1.0. Pick a new `--name` for each run. The run writes `runs/<name>.json` with the base model, the checkpoint, the run id, the dataset sha256, the settings, and the losses.

### Runs

| Version (checkpoint name) | Training run id | Session id | Dataset sha256 | Loss (step 1 → mean of steps 26–30) |
| --- | --- | --- | --- | --- |
| `health-cue-qwen35-9b-v1-2026-10-04` | `2058ed15-9c11-4d2f-9307-ae0c25113f7a` | `858cce65-638c-42c7-9008-de31fcb7040f` | `6518c38f…1c1f` | 1.381 → 0.452 |

Checkpoint: `river://2058ed15-9c11-4d2f-9307-ae0c25113f7a/sampler_weights/health-cue-qwen35-9b-v1-2026-10-04`. The job took about 4.5 minutes.

Credits: the River API key cannot read spend. Read it in the River Console under **Billing** and **Usage**, with a team login.

## Serve (versioned endpoint)

The plan is a River dedicated deployment (`train.py deploy`). On 2026-10-04 River rejected it for this account: `unsupported_topology: no approved unified specification for base model Qwen/Qwen3.5-9B`, and the same for prefill/decode. `Qwen/Qwen3.6-35B-A3B-FP8` gave the same error. Ask River to approve a deployment specification for the base model; then `train.py deploy --checkpoint river://... --confirm-paid` prints the server values.

Until then, `serve.py` is the endpoint. It pins one checkpoint and forwards OpenAI chat-completion requests to River's checkpoint chat API (`chat_complete_from_checkpoint`). It listens on 127.0.0.1 only, and it accepts only `Authorization: Bearer $RIVER_API_KEY`. It never logs request bodies.

```sh
.venv/bin/python serve.py --checkpoint river://2058ed15-9c11-4d2f-9307-ae0c25113f7a/sampler_weights/health-cue-qwen35-9b-v1-2026-10-04 --port 8003
```

## Server configuration

The server calls the endpoint for `POST /api/families/:familyId/cues` (`apps/server/src/integrations/qwen.ts`). It asks with `temperature: 0` and `chat_template_kwargs.enable_thinking: false`.

| Variable | Value |
| --- | --- |
| `QWEN_BASE_URL` | `http://127.0.0.1:8003/v1` for `serve.py`, or the deployment `base_url` |
| `QWEN_DEPLOYMENT` | `health-cue-qwen35-9b-v1-2026-10-04` (the checkpoint name, or the deployment model id) |
| `QWEN_CHECKPOINT` | The `river://` checkpoint. It is the model version in every cue |
| `RIVER_API_KEY` | The same key that `serve.py` holds; server-only |

Set all four values or none. With none, the route answers `503 unavailable`; it never sends a canned cue. A partial set stops the server at startup. A cue is advice only. It never feeds threshold evaluation or alert delivery.

Sample result through the server adapter (`requestCue`) and `serve.py`, with synthetic readings:

| Readings | Cue |
| --- | --- |
| `steps` 310 count | `{"kind":"walk","text":"A gentle walk around the room or to the window might be pleasant now."}` |
| `sleep_duration` 4.2 h | `{"kind":"rest","text":"Maybe lie down for a little while and relax."}` |
| `steps` 7400 count, `heart_rate` 68 bpm | `{"kind":"none","text":"No cue right now."}` |
| any, with a wrong key | `QwenUpstreamError` (HTTP 401) |

Each call took 3 to 7 seconds, within the server's 20-second timeout.

## Continuous integration

Ordinary CI does not train, deploy, or call River. The server tests use a local protocol server that speaks the same chat API.
