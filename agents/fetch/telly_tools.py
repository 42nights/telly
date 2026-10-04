"""Pure logic for the telly Fetch.ai worker: config, grants, contract checks, HTTP forward."""

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import aiohttp
from jsonschema import Draft202012Validator
from uagents import Model
from uagents_core.identity import is_valid_address

TIMEOUT = aiohttp.ClientTimeout(total=10)
MAX_BODY = 1024 * 1024

_contract = json.loads(Path(__file__).with_name("contract.json").read_text())
TOOL_REQUEST = Draft202012Validator(_contract["ToolRequest"])
TOOL_RESPONSE = Draft202012Validator(_contract["ToolResponse"])
API_ERROR = Draft202012Validator(_contract["ApiError"])

Reply = tuple[int, dict[str, Any]]


class ToolCall(Model):
    family_id: str
    request: dict[str, Any]


class ToolResult(Model):
    family_id: str
    status: int
    body: dict[str, Any]


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    seed: str
    server_url: str
    token: str
    grants: dict[str, frozenset[str]]
    port: int
    mailbox: bool


def load_config(env: Mapping[str, str] = os.environ) -> Config:
    def need(name: str) -> str:
        value = env.get(name, "")
        if not value.strip():
            raise ConfigError(f"{name} is required")
        return value

    seed = need("TELLY_FETCH_AGENT_SEED")
    server_url = need("TELLY_SERVER_URL").strip().rstrip("/")
    url = urlsplit(server_url)
    if url.scheme not in ("http", "https") or not url.netloc:
        raise ConfigError("TELLY_SERVER_URL must be an http(s) URL")
    token = need("TELLY_FETCH_SERVER_TOKEN")
    grants = parse_grants(need("TELLY_FETCH_GRANTS"))
    port = env.get("TELLY_FETCH_PORT", "8001")
    if not port.isdigit() or not 0 < int(port) < 65536:
        raise ConfigError("TELLY_FETCH_PORT must be a port number")
    mailbox = env.get("TELLY_FETCH_MAILBOX", "true").lower()
    if mailbox not in ("true", "false"):
        raise ConfigError("TELLY_FETCH_MAILBOX must be true or false")
    return Config(seed, server_url, token, grants, int(port), mailbox == "true")


def parse_grants(raw: str) -> dict[str, frozenset[str]]:
    shape = 'TELLY_FETCH_GRANTS must be a JSON object {"<agent address>": ["<family id>", ...]}'
    try:
        data = json.loads(raw)
    except ValueError:
        raise ConfigError(shape) from None
    if not isinstance(data, dict) or not all(
        is_valid_address(sender)
        and isinstance(families, list)
        and all(isinstance(f, str) and f for f in families)
        for sender, families in data.items()
    ):
        raise ConfigError(shape)
    return {sender: frozenset(families) for sender, families in data.items()}


def error(status: int, code: str, message: str) -> Reply:
    return status, {"error": code, "message": message}


async def handle_call(cfg: Config, sender: str, family_id: str, request: dict[str, Any]) -> Reply:
    """Check the grant and the request, forward to the server, and check its answer."""
    if family_id not in cfg.grants.get(sender, ()):
        return error(403, "forbidden", "sender has no grant for this family")
    if not TOOL_REQUEST.is_valid(request):
        return error(400, "invalid_request", "request does not match the ToolRequest schema")

    url = f"{cfg.server_url}/api/families/{quote(family_id, safe='')}/tools"
    headers = {"Authorization": f"Bearer {cfg.token}"}
    try:
        async with aiohttp.ClientSession(timeout=TIMEOUT) as session:
            # No redirects: a redirect must not carry the bearer token to another URL.
            async with session.post(url, json=request, headers=headers, allow_redirects=False) as resp:
                status = resp.status
                raw = bytearray()
                async for chunk in resp.content.iter_any():
                    raw += chunk
                    if len(raw) > MAX_BODY:
                        return error(502, "upstream_error", "server response is too large")
    except (aiohttp.ClientError, TimeoutError):
        return error(503, "unavailable", "telly server is unreachable")

    try:
        body = json.loads(raw)
    except ValueError:
        return error(502, "upstream_error", "server response is not JSON")
    schema = TOOL_RESPONSE if status == 200 else API_ERROR
    if not isinstance(body, dict) or not schema.is_valid(body):
        return error(502, "upstream_error", "server response does not match the contract")
    return status, body
