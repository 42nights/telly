"""Test client: send one signed ToolCall to the worker and print the ToolResult.

Usage:
  TELLY_FETCH_CLIENT_SEED=... python send_tool_call.py <worker address> <family id> '<request json>' \
      [--endpoint http://127.0.0.1:8001/submit]

The client posts straight to the worker's local /submit endpoint and waits for the
reply on the same HTTP call. It prints its own agent address to stderr; put that
address in the worker's TELLY_FETCH_GRANTS.
"""

import argparse
import asyncio
import json
import os
import sys

from uagents.communication import send_sync_message
from uagents.resolver import RulesBasedResolver
from uagents_core.identity import Identity

from telly_tools import ToolCall, ToolResult


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("worker_address")
    parser.add_argument("family_id")
    parser.add_argument("request", type=json.loads, help='e.g. \'{"tool":"alerts","input":{}}\'')
    parser.add_argument("--endpoint", default="http://127.0.0.1:8001/submit")
    args = parser.parse_args()

    seed = os.environ.get("TELLY_FETCH_CLIENT_SEED", "")
    if not seed.strip():
        sys.exit("send_tool_call: TELLY_FETCH_CLIENT_SEED is required")
    identity = Identity.from_seed(seed, 0)  # same derivation as Agent(seed=...)
    print(f"client address: {identity.address}", file=sys.stderr)

    result = await send_sync_message(
        destination=args.worker_address,
        message=ToolCall(family_id=args.family_id, request=args.request),
        response_type=ToolResult,
        sender=identity,
        resolver=RulesBasedResolver({args.worker_address: args.endpoint}),
    )
    if not isinstance(result, ToolResult):
        print(f"delivery failed: {result}", file=sys.stderr)
        return 1
    print(result.model_dump_json())
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
