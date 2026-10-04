# telly Fetch.ai agents

Agent tool calls go through Fetch.ai Agentverse:

```text
server (callAgentTool) --HTTP--> bridge uAgent --Agentverse mailbox--> worker uAgent --HTTP--> server POST /api/families/:familyId/tools
```

- `bridge.py` is the server's own uAgent. The server sends it one `BridgeCall` on its local port. The bridge sends a signed `ToolCall` to the worker and returns the worker's `ToolResult`.
- `main.py` is the worker. It accepts `ToolCall` messages only from senders in `TELLY_FETCH_GRANTS`, and only for their granted families. It calls the server with its own sign-in token. It also speaks the Agent Chat Protocol (see [Chat](#chat-agent-chat-protocol)).
- `telly_tools.py` holds the message models and the checks. Protocol: `telly-tools` version `0.1.0`.
- `telly_chat.py` maps one chat text to one tool call and writes the reply text.

Neither agent is an open relay:

- uAgents accepts only signed messages. The worker checks the sender's grant for the family.
- Both agents check each request against `contract.json`. The worker also checks each server response against `contract.json`.
- Messages do not carry credentials. The worker uses its own server token. The bridge accepts only calls that carry `TELLY_FETCH_BRIDGE_TOKEN`.
- The server checks sign-in and family membership again for the worker's identity.

## Caller API (server)

`callAgentTool(config.fetchAgent, familyId, request, signal)` in `apps/server/src/integrations/fetch.ts`:

- `request` is a `ToolRequest` from `@health/contracts/tools`. The result is a `ToolResponse` with only that family's records.
- A tool error becomes `ApiFailure` with the worker's or server's `ApiError` code.
- No configuration, no reply, or a timeout (40 s) gives `unavailable`. An invalid answer gives `upstream_error`. There are no retries.
- Check that the signed-in person is a member of the family before the call. The worker grant and the server check limit the call to the families of the worker's identity.

Do not call the tool route or `runTool` directly for agent tool calls. That skips Agentverse.

## Chat (Agent Chat Protocol)

The worker includes `AgentChatProtocol` version `0.3.0` from `uagents_core.contrib.protocols.chat`, the protocol that ASI:One uses. For each `ChatMessage` with text, the worker:

1. Sends a `ChatAcknowledgement` for the message id.
2. Maps the text to one tool. Text with "alert" runs `alerts`. A metric name ("heart rate", "resting heart rate", "heart rate variability", "hrv", "spo2", "oxygen", "respiratory rate", "breathing", "sleep") runs `health_samples` for that metric. "sample", "health", "vital", "reading", "latest", or "recent" runs `health_samples` for all metrics. Each tool returns at most 5 records. Other text gets a help reply and runs no tool.
3. Runs the tool through the same grant check, contract checks, and server route as a `ToolCall`. The family is the sender's only granted family, or the family that the text names ("family 12").
4. Sends one `ChatMessage` with the reply text and `EndSessionContent`.

A sender without a grant gets the acknowledgement and a refusal, and no tool runs. A message without text (for example, only `StartSessionContent`) gets only the acknowledgement.

Chat replies carry synthetic records only: samples with `synthetic: true`, and alerts whose summary starts with `Synthetic: `. The reply gives the number of withheld records, not their values. Grant a chat sender (such as the ASI:One sender address from the worker log) only a synthetic demo family. Do not grant it a family with real health data.

The worker log gives the chat sender, family, tool, and status, and no record values.

## Set up

Use Python 3.12.

```sh
cd agents/fetch
uv venv -p 3.12 .venv
uv pip install -p .venv/bin/python -r requirements.txt
.venv/bin/python -m unittest -v
```

## Environment

Worker (`main.py`):

| Variable | Required | Use |
| --- | --- | --- |
| `TELLY_FETCH_AGENT_SEED` | yes, secret | The seed for the worker identity. The same seed gives the same agent address. |
| `TELLY_SERVER_URL` | yes | The http(s) base URL of the telly server. |
| `TELLY_FETCH_SERVER_TOKEN` | yes, secret | The worker's OIDC token for the server. Its identity must be a member of each granted family. |
| `TELLY_FETCH_GRANTS` | yes | A JSON object. Each key is a sender agent address (the bridge, or a chat sender). Each value is a list of family ids, for example `{"agent1q...": ["12"]}`. Give a chat sender only a synthetic demo family. |
| `TELLY_FETCH_PORT` | no, default `8001` | The local HTTP port of the worker. |
| `TELLY_FETCH_MAILBOX` | no, default `true` | `true` uses an Agentverse mailbox. `false` turns off the mailbox and registration, for local tests only. |

Bridge (`bridge.py`):

| Variable | Required | Use |
| --- | --- | --- |
| `TELLY_FETCH_BRIDGE_SEED` | yes, secret | The seed for the bridge identity. Put its address in the worker's `TELLY_FETCH_GRANTS`. |
| `TELLY_FETCH_BRIDGE_TOKEN` | yes, secret | The shared secret that the server sends. Use the same value for the server's `TELLY_FETCH_BRIDGE_TOKEN`. |
| `TELLY_FETCH_WORKER_ADDRESS` | yes | The worker's agent address. |
| `TELLY_FETCH_BRIDGE_PORT` | no, default `8002` | The local HTTP port of the bridge. The server's `TELLY_FETCH_BRIDGE_URL` points here. |
| `TELLY_FETCH_MAILBOX` | no, default `true` | As for the worker. |
| `TELLY_FETCH_WORKER_ENDPOINT` | only with `TELLY_FETCH_MAILBOX=false` | The worker's local `/submit` URL, for local tests without Agentverse. |

If a variable is missing or not valid, the agent stops at start. The error message gives the variable name, not its value.

uAgents listens on all interfaces. Do not expose either agent port to the internet. Keep the bridge on the same host or private network as the server.

## Run with Agentverse

You need:

- An Agentverse account (https://agentverse.ai). The agents need no Agentverse API key, and mailbox registration needs no FET tokens.
- A sign-in identity for the worker from the server's OIDC issuer (issue #4), which a family member adds to each granted family. The issuer is Google: the identity is the Google Cloud service account `telly-fetch-worker`, in the same project as the OAuth client. `TELLY_FETCH_SERVER_TOKEN` is that account's Google ID token with the audience set to the OAuth web client ID (`TELLY_OIDC_CLIENT_ID`), for example from the IAM Credentials `generateIdToken` method. Google ID tokens expire after one hour, so the worker needs a new `TELLY_FETCH_SERVER_TOKEN` before expiry. `GET /api/me` with the token gives the identity to add.

Then do these steps one time for each agent:

1. Start the worker: `.venv/bin/python main.py`. Start the bridge: `.venv/bin/python bridge.py`.
2. Open the "Agent inspector" URL from each log.
3. Sign in to Agentverse. Click **Connect**, then select **Mailbox**. The browser sends your Agentverse session token to the agent's local `/connect` endpoint.

In mailbox mode, each agent polls Agentverse for its messages every second. A call takes at least two polls. Agentverse applies its own message and data quotas to mailboxes.

### Publish for ASI:One

When its mailbox connects, the worker sends `agentverse.md` as its public Agentverse README, with a short description. It also publishes the chat protocol manifest. Publish only with a synthetic demo family.

1. Start the worker with the mailbox on, and connect the mailbox as above.
2. On Agentverse, check that the agent profile shows the README and the `AgentChatProtocol` protocol.
3. Send a first chat from ASI:One. Read the sender address from the worker log (`chat sender=...`). Add it to `TELLY_FETCH_GRANTS` with only the synthetic demo family, then restart the worker.
4. Ask the question again in ASI:One.

Keep `agentverse.md` free of real data, addresses of private hosts, and secrets.

The browser asks to let agentverse.ai reach the local network for step 1. Allow it, or the inspector cannot find the agent.

Published agent: `telly-fetch`, address `agent1qvz4qf64ulzrvgrr0hd7mqrsr3y5t7rgnz6yp2qdrc6jkru2e8mz7x3dql6` ([Agentverse profile](https://agentverse.ai/agents/details/agent1qvz4qf64ulzrvgrr0hd7mqrsr3y5t7rgnz6yp2qdrc6jkru2e8mz7x3dql6/profile), [ASI:One page](https://asi1.ai/ai/agent1qvz4qf64ulzrvgrr0hd7mqrsr3y5t7rgnz6yp2qdrc6jkru2e8mz7x3dql6)). It answers only while its worker runs. On 2026-10-04, ASI:One chats got the synthetic alerts and heart rate samples of a synthetic demo family through the mailbox (issue #170).

## Run locally without Agentverse

This proves the protocol only. It is not a live Agentverse round trip.

```sh
TELLY_FETCH_MAILBOX=false TELLY_FETCH_PORT=8001 .venv/bin/python main.py
TELLY_FETCH_MAILBOX=false TELLY_FETCH_WORKER_ENDPOINT=http://127.0.0.1:8001/submit .venv/bin/python bridge.py
```

Then set `TELLY_FETCH_BRIDGE_URL=http://127.0.0.1:8002` and `TELLY_FETCH_BRIDGE_TOKEN` on the server.

With the mailbox off, the worker cannot look up the address of a chat sender. A local chat test must give the worker's resolver the sender's local `/submit` URL (for example, `uagents.resolver.RulesBasedResolver`).

## Update the contract

Do not edit `contract.json` by hand. Generate it from the shared Effect Schema:

```sh
bun run --filter @health/contracts agent-contract
```
