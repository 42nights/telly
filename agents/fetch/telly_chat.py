"""Agent Chat Protocol logic for the telly worker: map one chat text to one tool call, run it
through the worker's own grant and contract checks, and write the reply text.

Chat replies carry synthetic records only: samples with `synthetic: true`, and alerts whose
summary starts with "Synthetic: " (the database writes that prefix for synthetic samples).
"""

import re
from typing import Any

from telly_tools import Config, handle_call

MAX_TEXT = 2000
LIMIT = 5
SYNTHETIC_ALERT = "Synthetic: "

# Longer phrases first: "heart rate variability" must not match as "heart rate".
METRICS = (
    ("heart rate variability", "hrv"),
    ("resting heart rate", "resting_heart_rate"),
    ("respiratory rate", "respiratory_rate"),
    ("heart rate", "heart_rate"),
    ("hrv", "hrv"),
    ("spo2", "spo2"),
    ("oxygen", "spo2"),
    ("breathing", "respiratory_rate"),
    ("sleep", "sleep_duration"),
)
SAMPLE_WORDS = ("sample", "health", "vital", "reading", "latest", "recent")

HELP = (
    "Ask me about the telly demo family's alerts or newest health samples, for example "
    '"any alerts?", "latest heart rate", or "recent health samples".'
)


def plan(families: frozenset[str], text: str) -> tuple[str, dict[str, Any]] | str:
    """The family and ToolRequest for a chat text, or the reply text when no tool runs."""
    words = " ".join(text[:MAX_TEXT].lower().replace("_", " ").split())
    named = re.search(r"\bfamily (\d+)\b", words)
    if named:
        family = named.group(1)
    elif len(families) == 1:
        (family,) = families
    elif families:
        return "Name a family: " + ", ".join(f"family {f}" for f in sorted(families)) + "."
    else:
        return "This agent has no telly family for your agent address."

    if "alert" in words:
        return family, {"tool": "alerts", "input": {"limit": LIMIT}}
    metric = next((m for phrase, m in METRICS if re.search(rf"\b{phrase}\b", words)), None)
    if metric:
        return family, {"tool": "health_samples", "input": {"metric": metric, "limit": LIMIT}}
    if any(word in words for word in SAMPLE_WORDS):
        return family, {"tool": "health_samples", "input": {"limit": LIMIT}}
    return HELP


def _withheld(count: int, kind: str) -> list[str]:
    if not count:
        return []
    return [f"\n{count} {kind} not marked synthetic were withheld. Chat shows synthetic data only."]


def render(family: str, request: dict[str, Any], status: int, body: dict[str, Any]) -> str:
    """The reply text for one tool result. Only synthetic records go into it."""
    if status != 200:
        return f"telly could not get that data ({body['error']}): {body['message']}"
    if body["tool"] == "health_samples":
        metric = request["input"].get("metric", "health")
        kept = [s for s in body["samples"] if s["synthetic"]]
        lines = [
            f"Newest synthetic {metric} samples for family {family}:"
            if kept
            else f"Family {family} has no synthetic {metric} samples."
        ]
        lines += [
            f"- {s['metric']} {s['value']} {s['unit']} at {s['sourceTime']} ({s['quality']})"
            for s in kept
        ]
        return "\n".join(lines + _withheld(len(body["samples"]) - len(kept), "samples"))

    kept = [a for a in body["alerts"] if a["summary"].startswith(SYNTHETIC_ALERT)]
    acks: dict[str, int] = {}
    for ack in body["acknowledgements"]:
        acks[ack["alertId"]] = acks.get(ack["alertId"], 0) + 1
    lines = [
        f"Newest synthetic alerts for family {family}:"
        if kept
        else f"Family {family} has no synthetic alerts."
    ]
    lines += [
        f"- {a['summary']} (raised {a['createdAt']}, acknowledged {acks.get(a['id'], 0)} times)"
        for a in kept
    ]
    return "\n".join(lines + _withheld(len(body["alerts"]) - len(kept), "alerts"))


async def answer(cfg: Config, sender: str, text: str) -> tuple[str, str]:
    """The reply text for one chat text from `sender`, and a log line without record data."""
    planned = plan(cfg.grants.get(sender, frozenset()), text)
    if isinstance(planned, str):
        return planned, "tool=none"
    family, request = planned
    status, body = await handle_call(cfg, sender, family, request)
    return render(family, request, status, body), (
        f"family={family!r} tool={request['tool']!r} status={status}"
    )
