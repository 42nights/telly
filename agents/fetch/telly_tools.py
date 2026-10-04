"""Pure logic for the telly Fetch.ai worker and bridge: config, grants, contract checks, calls."""

import hmac
import json
import os
from collections.abc import Awaitable, Callable, Mapping
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
    # The server's per-question delegation for this family (server `delegation.ts`), if any.
    delegation: str | None = None


class ToolResult(Model):
    family_id: str
    status: int
    body: dict[str, Any]


class BridgeCall(Model):
    """The server's request to the bridge: its shared token, the family, one ToolRequest, and the
    question's delegation when the server gives one."""

    token: str
    family_id: str
    request: dict[str, Any]
    delegation: str | None = None


# Sends one ToolCall to the worker and waits for its ToolResult; None when nothing came back.
SendToWorker = Callable[[ToolCall], Awaitable[ToolResult | None]]


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
    # Read on each call instead of `token`, so a refreshed sign-in token needs no restart.
    token_file: str | None = None


@dataclass(frozen=True)
class BridgeConfig:
    seed: str
    token: str
    worker: str
    port: int
    mailbox: bool
    # Local runs only (mailbox off): the worker's /submit URL, since Agentverse does not route.
    worker_endpoint: str | None


def _need(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "")
    if not value.strip():
        raise ConfigError(f"{name} is required")
    return value


def _http_url(env: Mapping[str, str], name: str) -> str:
    value = _need(env, name).strip().rstrip("/")
    url = urlsplit(value)
    if url.scheme not in ("http", "https") or not url.netloc:
        raise ConfigError(f"{name} must be an http(s) URL")
    return value


def _port(env: Mapping[str, str], name: str, default: str) -> int:
    port = env.get(name, default)
    if not port.isdigit() or not 0 < int(port) < 65536:
        raise ConfigError(f"{name} must be a port number")
    return int(port)


def _mailbox(env: Mapping[str, str]) -> bool:
    mailbox = env.get("TELLY_FETCH_MAILBOX", "true").lower()
    if mailbox not in ("true", "false"):
        raise ConfigError("TELLY_FETCH_MAILBOX must be true or false")
    return mailbox == "true"


def load_config(env: Mapping[str, str] = os.environ) -> Config:
    token_file = env.get("TELLY_FETCH_SERVER_TOKEN_FILE", "").strip() or None
    return Config(
        seed=_need(env, "TELLY_FETCH_AGENT_SEED"),
        server_url=_http_url(env, "TELLY_SERVER_URL"),
        token="" if token_file else _need(env, "TELLY_FETCH_SERVER_TOKEN"),
        grants=parse_grants(_need(env, "TELLY_FETCH_GRANTS")),
        port=_port(env, "TELLY_FETCH_PORT", "8001"),
        mailbox=_mailbox(env),
        token_file=token_file,
    )


def load_bridge_config(env: Mapping[str, str] = os.environ) -> BridgeConfig:
    worker = _need(env, "TELLY_FETCH_WORKER_ADDRESS").strip()
    if not is_valid_address(worker):
        raise ConfigError("TELLY_FETCH_WORKER_ADDRESS must be an agent address")
    mailbox = _mailbox(env)
    if mailbox and env.get("TELLY_FETCH_WORKER_ENDPOINT"):
        raise ConfigError("TELLY_FETCH_WORKER_ENDPOINT is only for TELLY_FETCH_MAILBOX=false")
    return BridgeConfig(
        seed=_need(env, "TELLY_FETCH_BRIDGE_SEED"),
        token=_need(env, "TELLY_FETCH_BRIDGE_TOKEN"),
        worker=worker,
        port=_port(env, "TELLY_FETCH_BRIDGE_PORT", "8002"),
        mailbox=mailbox,
        worker_endpoint=None if mailbox else _http_url(env, "TELLY_FETCH_WORKER_ENDPOINT"),
    )


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


def _server_headers(cfg: Config, delegation: str | None) -> dict[str, str] | None:
    """The worker's sign-in, read from the token file on each call when set, and the delegation.
    None when there is no token."""
    try:
        token = Path(cfg.token_file).read_text().strip() if cfg.token_file else cfg.token
    except OSError:
        return None
    if not token:
        return None
    headers = {"Authorization": f"Bearer {token}"}
    if delegation:
        headers["X-Telly-Delegation"] = delegation
    return headers


async def handle_call(
    cfg: Config,
    sender: str,
    family_id: str,
    request: dict[str, Any],
    delegation: str | None = None,
) -> Reply:
    """Check the grant and the request, forward to the server, and check its answer. A "*" grant
    covers any family, but only with the server's delegation: the server then lends the asking
    member's access for that one family, and the worker needs no standing access."""
    granted = cfg.grants.get(sender, frozenset())
    if family_id not in granted and not ("*" in granted and delegation):
        return error(403, "forbidden", "sender has no grant for this family")
    if not TOOL_REQUEST.is_valid(request):
        return error(400, "invalid_request", "request does not match the ToolRequest schema")
    headers = _server_headers(cfg, delegation)
    if headers is None:
        return error(503, "unavailable", "the worker has no server sign-in token")

    url = f"{cfg.server_url}/api/families/{quote(family_id, safe='')}/tools"
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


async def bridge_call(cfg: BridgeConfig, call: BridgeCall, send: SendToWorker) -> ToolResult:
    """Check the server's token and the request, then ask the worker through Agentverse."""

    def fail(status: int, code: str, message: str) -> ToolResult:
        _, body = error(status, code, message)
        return ToolResult(family_id=call.family_id, status=status, body=body)

    if not hmac.compare_digest(call.token.encode(), cfg.token.encode()):
        return fail(401, "unauthorized", "bridge token is not valid")
    if not TOOL_REQUEST.is_valid(call.request):
        return fail(400, "invalid_request", "request does not match the ToolRequest schema")
    result = await send(
        ToolCall(family_id=call.family_id, request=call.request, delegation=call.delegation)
    )
    if result is None:
        return fail(503, "unavailable", "the Fetch.ai worker did not reply through Agentverse")
    if result.family_id != call.family_id:
        return fail(502, "upstream_error", "the worker replied for another family")
    return result
