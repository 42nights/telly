"""telly Fetch.ai worker: answers ToolCall messages from granted Agentverse agents."""

import sys

from uagents import Agent, Context, Protocol

from telly_tools import ConfigError, ToolCall, ToolResult, error, handle_call, load_config

try:
    cfg = load_config()
except ConfigError as exc:
    sys.exit(f"telly fetch worker: {exc}")

agent = Agent(name="telly-fetch", seed=cfg.seed, port=cfg.port, mailbox=cfg.mailbox)
# The inspector caches every message payload in memory and serves it at GET /messages
# (CORS *, bound to 0.0.0.0). Replies carry health data, so turn that cache off.
# The inspector stays on because Agentverse "Connect" (mailbox setup) calls POST /connect.
agent._message_history = None

protocol = Protocol(name="telly-tools", version="0.1.0")


@protocol.on_message(ToolCall, replies=ToolResult)
async def on_tool_call(ctx: Context, sender: str, msg: ToolCall) -> None:
    try:
        status, body = await handle_call(cfg, sender, msg.family_id, msg.request)
    except Exception as exc:  # a handler must never crash the agent
        ctx.logger.error(f"unexpected {type(exc).__name__} for sender={sender}")
        status, body = error(500, "internal", "worker error")
    tool = str(msg.request.get("tool"))[:40]
    ctx.logger.info(f"sender={sender} family={msg.family_id[:40]!r} tool={tool!r} status={status}")
    await ctx.send(sender, ToolResult(family_id=msg.family_id, status=status, body=body))


agent.include(protocol, publish_manifest=cfg.mailbox)

if __name__ == "__main__":
    agent.run()
