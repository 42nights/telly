"""telly Fetch.ai worker: answers ToolCall messages from granted Agentverse agents, and Agent
Chat Protocol messages from granted chat senders (such as ASI:One) with synthetic records only."""

import os
import sys

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)

from telly_chat import answer
from telly_tools import ConfigError, ToolCall, ToolResult, error, handle_call, load_config

try:
    cfg = load_config()
except ConfigError as exc:
    sys.exit(f"telly fetch worker: {exc}")

agent = Agent(
    name="telly-fetch",
    seed=cfg.seed,
    port=cfg.port,
    mailbox=cfg.mailbox,
    # Public on Agentverse and ASI:One: synthetic demo family only, no addresses or secrets.
    readme_path=os.path.join(os.path.dirname(os.path.abspath(__file__)), "agentverse.md"),
    description="telly demo care agent: alerts and health readings for one synthetic family.",
)
# The inspector caches every message payload in memory and serves it at GET /messages
# (CORS *, bound to 0.0.0.0). Replies carry health data, so turn that cache off.
# The inspector stays on because Agentverse "Connect" (mailbox setup) calls POST /connect.
agent._message_history = None

protocol = Protocol(name="telly-tools", version="0.1.0")


@protocol.on_message(ToolCall, replies=ToolResult)
async def on_tool_call(ctx: Context, sender: str, msg: ToolCall) -> None:
    try:
        status, body = await handle_call(cfg, sender, msg.family_id, msg.request, msg.delegation)
    except Exception as exc:  # a handler must never crash the agent
        ctx.logger.error(f"unexpected {type(exc).__name__} for sender={sender}")
        status, body = error(500, "internal", "worker error")
    tool = str(msg.request.get("tool"))[:40]
    ctx.logger.info(f"sender={sender} family={msg.family_id[:40]!r} tool={tool!r} status={status}")
    await ctx.send(sender, ToolResult(family_id=msg.family_id, status=status, body=body))


chat = Protocol(spec=chat_protocol_spec)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))
    text = msg.text()
    if not text.strip():  # session start or metadata only: nothing to answer
        return
    try:
        reply, outcome = await answer(cfg, sender, text)
    except Exception as exc:  # a handler must never crash the agent
        ctx.logger.error(f"unexpected {type(exc).__name__} in chat from sender={sender}")
        reply, outcome = "telly could not answer. Try again later.", "status=500"
    ctx.logger.info(f"chat sender={sender} {outcome}")
    await ctx.send(sender, ChatMessage([TextContent(text=reply), EndSessionContent()]))


@chat.on_message(ChatAcknowledgement)
async def on_chat_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
    pass  # the sender received our reply; nothing to do


agent.include(protocol, publish_manifest=cfg.mailbox)
agent.include(chat, publish_manifest=cfg.mailbox)

if __name__ == "__main__":
    agent.run()
