"""Versioned inference endpoint for the trained Qwen cue checkpoint, through River queued inference.

River has no approved dedicated-deployment specification for Qwen/Qwen3.5-9B on this account
(`train.py deploy` fails with `unsupported_topology`). This bridge serves one pinned `river://`
checkpoint through River's checkpoint chat API and speaks the OpenAI chat-completions protocol that
apps/server/src/integrations/qwen.ts already uses. Callers must send `Authorization: Bearer
$RIVER_API_KEY`, the same key the bridge holds. It listens on 127.0.0.1 only.

    python serve.py --checkpoint river://RUN/sampler_weights/NAME [--port 8003]

Then set on the server: QWEN_BASE_URL=http://127.0.0.1:8003/v1, QWEN_DEPLOYMENT=NAME,
QWEN_CHECKPOINT=river://RUN/sampler_weights/NAME.
"""

import argparse
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from train import DEFAULT_BASE_MODEL, river_client

# The request fields forwarded to River; the bridge pins the model, so `model` is ignored.
FORWARDED = ("temperature", "max_tokens", "chat_template_kwargs", "stop", "top_p")


def handler(river, client, key, checkpoint, base_model):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/chat/completions":
                return self.reply(404, {"error": {"message": "not found"}})
            if not hmac.compare_digest(self.headers.get("authorization", ""), f"Bearer {key}"):
                return self.reply(401, {"error": {"message": "unauthorized"}})
            try:
                request = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                messages = request["messages"]
            except (ValueError, KeyError, TypeError):
                return self.reply(400, {"error": {"message": "expected a chat-completions body"}})
            if request.get("stream"):
                return self.reply(400, {"error": {"message": "streaming is not supported"}})
            try:
                result = client.chat_complete_from_checkpoint(
                    messages,
                    checkpoint_path=checkpoint,
                    base_model=base_model,
                    timeout=60,
                    **{k: request[k] for k in FORWARDED if k in request},
                )
            except river.CapacityError:
                return self.reply(503, {"error": {"message": "River has no capacity"}})
            except river.RiverError as error:
                # Never echo the provider message: it can quote the request.
                print(f"serve.py: River call failed: {type(error).__name__}", flush=True)
                return self.reply(502, {"error": {"message": "River call failed"}})
            self.reply(result.status_code, json.loads(result.response_json))

        def log_message(self, fmt, *args):
            # Log the request line and status only; never bodies (health readings).
            print(f"serve.py: {self.address_string()} {fmt % args}", flush=True)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--checkpoint", required=True, help="river://RUN/sampler_weights/NAME")
    parser.add_argument("--base-model", default=DEFAULT_BASE_MODEL)
    parser.add_argument("--port", type=int, default=8003)
    args = parser.parse_args()
    river, client = river_client()
    key = os.environ["RIVER_API_KEY"]
    server = ThreadingHTTPServer(
        ("127.0.0.1", args.port), handler(river, client, key, args.checkpoint, args.base_model)
    )
    print(f"serve.py: {args.checkpoint} on http://127.0.0.1:{args.port}/v1", flush=True)
    try:
        server.serve_forever()
    finally:
        client.close()


if __name__ == "__main__":
    main()
