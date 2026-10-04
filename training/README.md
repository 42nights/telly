# Gemma health-cue training on River

This folder trains the Gemma model that turns validated health readings into one short cue, such as a walk reminder.
River AI runs the training and serves the model. The model never runs on the glasses.
Plan: [`docs/board.html`](../docs/board.html) (`sys-training`, `sys-models`). Issues: #9 (River access) and #10 (training and inference).

## What is here

| Path | Purpose |
| --- | --- |
| `gemma/train.py` | The entry point: `validate`, `check`, `train`, `deploy` |
| `gemma/requirements.txt` | Pinned Python dependencies (`river-client` 0.12.0) |
| `gemma/fixtures/synthetic.jsonl` | Four synthetic examples. They prove the format only. Do not train a release on them |
| `../packages/contracts/src/cue-format.json` | The prompt and output format. Training and the server read this one file |

Git ignores `gemma/data/` (datasets), `gemma/runs/` (run manifests), and model weight files. Do not commit training data, recordings, or weights.

## Prerequisites (human tasks)

1. **Your own River account.** Sign up at [river.ai](https://river.ai) and create your own API key on the **API Keys** page of the [River Console](https://console.river.ai/). Do not share a login or a key, and do not put a key in the repository or in an issue.
2. **Gemma access on River.** River's [public model list](https://docs.river.ai/guides/models/) (checked 2026-10-04) has no Gemma model. Ask River for Gemma access (support@river.ai or their Discord), then confirm it with `train.py check`. If River cannot enable Gemma, the captain must choose a different base model.
3. **Hugging Face access to the Gemma tokenizer.** Gemma repositories are gated. Accept the Gemma license on Hugging Face and set `HF_TOKEN` before `train` runs.
4. **Cost approval.** `train` and `deploy` use paid River capacity. Run them only after the owner approves the cost. Both refuse to start without `--confirm-paid`.
5. **Deployment access.** Serving needs a River team API key with dedicated-deployment access for the base model. Personal keys cannot create deployments. Ask River to enable it.

## Set up

```sh
cd training/gemma
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
export RIVER_API_KEY=...   # your own key, from your secret store
```

## Steps

1. Validate a dataset (free, local). Each JSONL line is `{"readings":[{"metric","value","unit","sourceTime"}],"cue":{"kind","text"}}`. `kind` is one of `walk`, `hydrate`, `rest`, `none`; `text` has 1 to 160 characters.

   ```sh
   .venv/bin/python train.py validate data/cues.jsonl --tokenizer google/gemma-3-1b-it
   ```

   `--tokenizer` also builds the masked training tokens: the loss covers only the model reply.

2. Check River access (free; for #9, post the result and your River project name):

   ```sh
   .venv/bin/python train.py check --base-model <gemma model name from River>
   ```

3. Train (paid). Pick a new `--name` for each run:

   ```sh
   .venv/bin/python train.py train data/cues.jsonl --base-model <name> --name health-cue-v1-2026-10-04 --confirm-paid
   ```

   The run writes `runs/<name>.json`: base model, `river://` checkpoint, training run id, dataset sha256, settings, and losses. Post the checkpoint and run id on #10 (no secrets).

4. Deploy (paid), then set the printed values on the server:

   ```sh
   .venv/bin/python train.py deploy --checkpoint river://<run>/sampler_weights/<name> --confirm-paid
   ```

## Server configuration

The server calls the deployment's OpenAI-compatible chat API for `POST /api/families/:familyId/cues`.

| Variable | Value |
| --- | --- |
| `GEMMA_BASE_URL` | Deployment `base_url`, printed by `deploy` |
| `GEMMA_DEPLOYMENT` | Deployment model id, printed by `deploy` |
| `GEMMA_CHECKPOINT` | The `river://` checkpoint the deployment serves; the model version in every cue |
| `RIVER_API_KEY` | A key that can call the deployment; server-only |

Set all four values or none. With none, the route answers `503 unavailable`; it never sends a canned cue. A partial set stops the server at startup.
A cue is advice only. It never feeds threshold evaluation or alert delivery.

## Continuous integration

Ordinary CI does not train, deploy, or call River. The server tests use a local protocol server that speaks the same chat API. That proves this server's side of the protocol only, not a trained model or a live deployment.
