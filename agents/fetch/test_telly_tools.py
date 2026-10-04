"""Tests for telly_tools. The aiohttp.web upstream here is a test-only fake telly server."""

import asyncio
import json
import socket
import unittest
from unittest import mock

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

import telly_tools
from telly_tools import (
    BridgeCall,
    BridgeConfig,
    Config,
    ConfigError,
    ToolCall,
    ToolResult,
    bridge_call,
    handle_call,
    load_bridge_config,
    load_config,
)

SENDER = "agent1q" + "a" * 58
OTHER = "agent1q" + "b" * 58
REQUEST = {"tool": "alerts", "input": {}}
ALERTS = {"tool": "alerts", "alerts": [], "acknowledgements": []}


def config(server_url: str) -> Config:
    return Config("seed", server_url, "worker-token", {SENDER: frozenset({"12"})}, 8001, False)


class HandleCallTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.calls: list[tuple[str, str | None, dict]] = []
        self.reply: web.StreamResponse = web.json_response(ALERTS)

        async def tools(request: web.Request) -> web.StreamResponse:
            self.calls.append(
                (request.path_qs, request.headers.get("Authorization"), await request.json())
            )
            return self.reply

        app = web.Application()
        app.router.add_post("/api/families/{family}/tools", tools)
        self.server = TestServer(app)
        await self.server.start_server()
        self.cfg = config(str(self.server.make_url("")).rstrip("/"))

    async def asyncTearDown(self) -> None:
        await self.server.close()

    async def test_ungranted_sender_or_family_is_forbidden_without_call(self) -> None:
        for sender, family in ((OTHER, "12"), (SENDER, "13")):
            status, body = await handle_call(self.cfg, sender, family, REQUEST)
            self.assertEqual((status, body["error"]), (403, "forbidden"))
        self.assertEqual(self.calls, [])

    async def test_unsupported_tool_is_invalid_without_call(self) -> None:
        status, body = await handle_call(self.cfg, SENDER, "12", {"tool": "rm_rf", "input": {}})
        self.assertEqual((status, body["error"]), (400, "invalid_request"))
        self.assertEqual(self.calls, [])

    async def test_valid_call_is_forwarded_and_passed_through(self) -> None:
        status, body = await handle_call(self.cfg, SENDER, "12", REQUEST)
        self.assertEqual((status, body), (200, ALERTS))
        self.assertEqual(self.calls, [("/api/families/12/tools", "Bearer worker-token", REQUEST)])

    async def test_family_id_is_url_encoded(self) -> None:
        cfg = Config("seed", self.cfg.server_url, "t", {SENDER: frozenset({"a/b"})}, 8001, False)
        await handle_call(cfg, SENDER, "a/b", REQUEST)
        self.assertEqual(self.calls[0][0], "/api/families/a%2Fb/tools")

    async def test_server_api_error_is_passed_through(self) -> None:
        denied = {"error": "forbidden", "message": "no access"}
        self.reply = web.json_response(denied, status=403)
        self.assertEqual(await handle_call(self.cfg, SENDER, "12", REQUEST), (403, denied))

    async def test_bad_upstream_body_is_upstream_error(self) -> None:
        for reply in (
            web.Response(text="<html>oops</html>"),
            web.json_response({"tool": "alerts"}),
            web.json_response({"oops": True}, status=500),
            web.Response(body=b" " * (telly_tools.MAX_BODY + 1), content_type="application/json"),
        ):
            self.reply = reply
            status, body = await handle_call(self.cfg, SENDER, "12", REQUEST)
            self.assertEqual((status, body["error"]), (502, "upstream_error"))

    async def test_timeout_is_unavailable(self) -> None:
        async def slow(request: web.Request) -> web.Response:
            await asyncio.sleep(1)
            return web.json_response(ALERTS)

        app = web.Application()
        app.router.add_post("/api/families/{family}/tools", slow)
        async with TestServer(app) as server:
            cfg = config(str(server.make_url("")).rstrip("/"))
            with mock.patch.object(telly_tools, "TIMEOUT", aiohttp.ClientTimeout(total=0.1)):
                status, body = await handle_call(cfg, SENDER, "12", REQUEST)
        self.assertEqual((status, body["error"]), (503, "unavailable"))

    async def test_connection_refused_is_unavailable(self) -> None:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        status, body = await handle_call(config(f"http://127.0.0.1:{port}"), SENDER, "12", REQUEST)
        self.assertEqual((status, body["error"]), (503, "unavailable"))


class LoadConfigTest(unittest.TestCase):
    ENV = {
        "TELLY_FETCH_AGENT_SEED": "seed",
        "TELLY_SERVER_URL": "http://localhost:3000/",
        "TELLY_FETCH_SERVER_TOKEN": "token",
        "TELLY_FETCH_GRANTS": json.dumps({SENDER: ["12"]}),
    }

    def test_valid_env(self) -> None:
        cfg = load_config(self.ENV)
        self.assertEqual(cfg.server_url, "http://localhost:3000")
        self.assertEqual(cfg.grants, {SENDER: frozenset({"12"})})
        self.assertEqual((cfg.port, cfg.mailbox), (8001, True))

    def test_missing_var_is_named_without_value(self) -> None:
        for name in self.ENV:
            env = {k: v for k, v in self.ENV.items() if k != name}
            with self.assertRaisesRegex(ConfigError, name):
                load_config(env)

    def test_bad_grants_shape(self) -> None:
        for grants in ("[]", "{", '{"not-an-address": ["12"]}', json.dumps({SENDER: "12"})):
            with self.assertRaisesRegex(ConfigError, "TELLY_FETCH_GRANTS"):
                load_config({**self.ENV, "TELLY_FETCH_GRANTS": grants})


class BridgeCallTest(unittest.IsolatedAsyncioTestCase):
    CFG = BridgeConfig("seed", "server-secret", SENDER, 8002, True, None)

    async def asyncSetUp(self) -> None:
        self.sent: list[ToolCall] = []
        self.reply: ToolResult | None = ToolResult(family_id="12", status=200, body=ALERTS)

    async def send(self, message: ToolCall) -> ToolResult | None:
        self.sent.append(message)
        return self.reply

    async def call(self, token: str = "server-secret", request: dict = REQUEST) -> ToolResult:
        return await bridge_call(
            self.CFG, BridgeCall(token=token, family_id="12", request=request), self.send
        )

    async def test_wrong_token_or_bad_request_is_refused_without_sending(self) -> None:
        result = await self.call(token="guess")
        self.assertEqual((result.status, result.body["error"]), (401, "unauthorized"))
        result = await self.call(request={"tool": "run_sql", "input": {}})
        self.assertEqual((result.status, result.body["error"]), (400, "invalid_request"))
        self.assertEqual(self.sent, [])

    async def test_worker_result_is_returned(self) -> None:
        result = await self.call()
        self.assertEqual((result.status, result.body), (200, ALERTS))
        self.assertEqual(self.sent, [ToolCall(family_id="12", request=REQUEST)])

    async def test_no_reply_is_unavailable_and_other_family_is_upstream_error(self) -> None:
        self.reply = None
        result = await self.call()
        self.assertEqual((result.status, result.body["error"]), (503, "unavailable"))
        self.reply = ToolResult(family_id="13", status=200, body=ALERTS)
        result = await self.call()
        self.assertEqual((result.status, result.body["error"]), (502, "upstream_error"))


class LoadBridgeConfigTest(unittest.TestCase):
    ENV = {
        "TELLY_FETCH_BRIDGE_SEED": "seed",
        "TELLY_FETCH_BRIDGE_TOKEN": "secret",
        "TELLY_FETCH_WORKER_ADDRESS": SENDER,
    }

    def test_mailbox_is_default_and_local_endpoint_needs_mailbox_off(self) -> None:
        cfg = load_bridge_config(self.ENV)
        self.assertEqual((cfg.port, cfg.mailbox, cfg.worker_endpoint), (8002, True, None))
        local = "http://127.0.0.1:8001/submit"
        with self.assertRaisesRegex(ConfigError, "TELLY_FETCH_WORKER_ENDPOINT"):
            load_bridge_config({**self.ENV, "TELLY_FETCH_WORKER_ENDPOINT": local})
        with self.assertRaisesRegex(ConfigError, "TELLY_FETCH_WORKER_ENDPOINT"):
            load_bridge_config({**self.ENV, "TELLY_FETCH_MAILBOX": "false"})
        cfg = load_bridge_config(
            {**self.ENV, "TELLY_FETCH_MAILBOX": "false", "TELLY_FETCH_WORKER_ENDPOINT": local}
        )
        self.assertEqual(cfg.worker_endpoint, local)

    def test_missing_var_or_bad_address_is_named(self) -> None:
        for name in self.ENV:
            with self.assertRaisesRegex(ConfigError, name):
                load_bridge_config({k: v for k, v in self.ENV.items() if k != name})
        with self.assertRaisesRegex(ConfigError, "TELLY_FETCH_WORKER_ADDRESS"):
            load_bridge_config({**self.ENV, "TELLY_FETCH_WORKER_ADDRESS": "agent1nope"})


if __name__ == "__main__":
    unittest.main()
