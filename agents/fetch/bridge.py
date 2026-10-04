"""telly Fetch.ai bridge: the server's own uAgent. It sends ToolCall messages to the worker
through Agentverse and returns the worker's ToolResult to the server.

The server POSTs a BridgeCall to /tool-call on this agent's local port. The bridge checks the
server's shared token and the request, then sends a signed ToolCall to the worker's address. With
the mailbox on, Agentverse stores the message until the worker polls it, and stores the reply until
this agent polls it.
"""

import sys

from uagents import Agent, Context
from uagents.resolver import RulesBasedResolver

from telly_tools import BridgeCall, ConfigError, ToolCall, ToolResult, bridge_call, load_bridge_config

# Agentverse delivery and the worker's server call together must finish in this time.
REPLY_TIMEOUT_SECONDS = 30

try:
    cfg = load_bridge_config()
except ConfigError as exc:
    sys.exit(f"telly fetch bridge: {exc}")

agent = Agent(
    name="telly-fetch-bridge",
    seed=cfg.seed,
    port=cfg.port,
    mailbox=cfg.mailbox,
    # Local runs only: reach the worker's /submit directly. Otherwise the Almanac resolves the
    # worker's address to its Agentverse mailbox.
    resolve=RulesBasedResolver({cfg.worker: cfg.worker_endpoint}) if cfg.worker_endpoint else None,
)
# Same as the worker: do not keep message payloads (health data) in the inspector cache.
agent._message_history = None


@agent.on_rest_post("/tool-call", BridgeCall, ToolResult)
async def on_tool_call(ctx: Context, call: BridgeCall) -> ToolResult:
    async def send(message: ToolCall) -> ToolResult | None:
        reply, status = await ctx.send_and_receive(
            cfg.worker,
            message,
            response_type=ToolResult,
            # Without a mailbox, the worker answers on the same HTTP call.
            sync=not cfg.mailbox,
            timeout=REPLY_TIMEOUT_SECONDS,
        )
        if reply is None:
            ctx.logger.warning(f"no reply from the worker: {status.detail}")
        return reply if isinstance(reply, ToolResult) else None

    try:
        result = await bridge_call(cfg, call, send)
    except Exception as exc:  # a handler must never crash the agent
        ctx.logger.error(f"unexpected {type(exc).__name__}")
        result = ToolResult(
            family_id=call.family_id,
            status=500,
            body={"error": "internal", "message": "bridge error"},
        )
    tool = str(call.request.get("tool"))[:40]
    ctx.logger.info(f"family={call.family_id[:40]!r} tool={tool!r} status={result.status}")
    return result


if __name__ == "__main__":
    agent.run()
