"""Tests for telly_chat. The aiohttp.web upstream here is a test-only fake telly server."""

import unittest

from aiohttp import web
from aiohttp.test_utils import TestServer

from telly_chat import HELP, answer, plan, render
from telly_tools import Config

SENDER = "agent1q" + "a" * 58
OTHER = "agent1q" + "b" * 58


def sample(value: float, synthetic: bool) -> dict:
    return {
        "id": str(int(value)),
        "familyId": "12",
        "metric": "heart_rate",
        "value": value,
        "unit": "bpm",
        "sourceTime": "2026-01-01T08:00:00.000Z",
        "receivedAt": "2026-01-01T08:00:01.000Z",
        "source": "demo",
        "synthetic": synthetic,
        "quality": "validated",
    }


def alert(id: str, summary: str) -> dict:
    return {
        "id": id,
        "familyId": "12",
        "sampleId": None,
        "summary": summary,
        "raisedBy": "x",
        "createdAt": "2026-01-01T08:00:02.000Z",
    }


class PlanTest(unittest.TestCase):
    def test_text_maps_to_one_tool(self) -> None:
        one = frozenset({"12"})
        for text, request in (
            ("Any ALERTS today?", {"tool": "alerts", "input": {"limit": 5}}),
            ("latest heart rate", {"tool": "health_samples", "input": {"metric": "heart_rate", "limit": 5}}),
            ("heart rate variability?", {"tool": "health_samples", "input": {"metric": "hrv", "limit": 5}}),
            ("resting_heart_rate", {"tool": "health_samples", "input": {"metric": "resting_heart_rate", "limit": 5}}),
            ("recent health samples", {"tool": "health_samples", "input": {"limit": 5}}),
        ):
            self.assertEqual(plan(one, text), ("12", request), text)

    def test_family_choice(self) -> None:
        two = frozenset({"12", "3"})
        self.assertEqual(plan(two, "alerts"), "Name a family: family 12, family 3.")
        self.assertEqual(plan(two, "alerts for family 3")[0], "3")
        # A named family is checked by the grant in handle_call, not trusted here.
        self.assertEqual(plan(frozenset({"12"}), "family 9 alerts")[0], "9")
        self.assertIn("no telly family", plan(frozenset(), "alerts"))

    def test_unrelated_text_gets_help_without_tool(self) -> None:
        self.assertEqual(plan(frozenset({"12"}), "hello there"), HELP)


class RenderTest(unittest.TestCase):
    def test_non_synthetic_samples_are_withheld(self) -> None:
        request = {"tool": "health_samples", "input": {"metric": "heart_rate"}}
        body = {"tool": "health_samples", "samples": [sample(61.5, True), sample(140, False)]}
        text = render("12", request, 200, body)
        self.assertIn("heart_rate 61.5 bpm at 2026-01-01T08:00:00.000Z (validated)", text)
        self.assertNotIn("140", text)
        self.assertIn("1 samples not marked synthetic were withheld", text)

    def test_non_synthetic_alerts_are_withheld(self) -> None:
        body = {
            "tool": "alerts",
            "alerts": [alert("1", "Synthetic: heart_rate 150 bpm is above 110 bpm"), alert("2", "real 99")],
            "acknowledgements": [
                {"id": "5", "alertId": "1", "familyId": "12", "member": "m", "acknowledgedAt": "t"}
            ],
        }
        text = render("12", {"tool": "alerts", "input": {}}, 200, body)
        self.assertIn("Synthetic: heart_rate 150 bpm is above 110 bpm", text)
        self.assertIn("acknowledged 1 times", text)
        self.assertNotIn("real 99", text)
        self.assertIn("1 alerts not marked synthetic were withheld", text)

    def test_error_is_reported(self) -> None:
        body = {"error": "forbidden", "message": "sender has no grant for this family"}
        text = render("12", {"tool": "alerts", "input": {}}, 403, body)
        self.assertEqual(text, "telly could not get that data (forbidden): sender has no grant for this family")


class AnswerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.calls: list[str] = []

        async def tools(request: web.Request) -> web.Response:
            self.calls.append(request.path)
            return web.json_response({"tool": "health_samples", "samples": [sample(61.5, True)]})

        app = web.Application()
        app.router.add_post("/api/families/{family}/tools", tools)
        self.server = TestServer(app)
        await self.server.start_server()
        url = str(self.server.make_url("")).rstrip("/")
        self.cfg = Config("seed", url, "worker-token", {SENDER: frozenset({"12"})}, 8001, False)

    async def asyncTearDown(self) -> None:
        await self.server.close()

    async def test_granted_sender_gets_tool_result(self) -> None:
        text, log = await answer(self.cfg, SENDER, "latest heart rate")
        self.assertIn("heart_rate 61.5 bpm", text)
        self.assertEqual(log, "family='12' tool='health_samples' status=200")
        self.assertEqual(self.calls, ["/api/families/12/tools"])

    async def test_ungranted_sender_or_family_runs_no_tool(self) -> None:
        for sender, text in ((OTHER, "alerts"), (OTHER, "family 12 alerts"), (SENDER, "family 13 alerts")):
            reply, _ = await answer(self.cfg, sender, text)
            self.assertNotIn("Newest", reply)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
