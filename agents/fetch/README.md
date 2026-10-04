# telly Fetch.ai worker

This uAgents worker receives `ToolCall` messages from Agentverse agents. It sends each call to the telly server and replies with a `ToolResult`.

The worker is not an open relay:

- It accepts only signed messages. Each sender must be in `TELLY_FETCH_GRANTS` for the requested family.
- It checks each request against `contract.json` before it calls the server. It also checks the server response against `contract.json`.
- It uses its own server token. Messages do not carry credentials.

Protocol: `telly-tools` version `0.1.0`. The message models are in `telly_tools.py`.

## Set up

Use Python 3.12.

```sh
cd agents/fetch
uv venv -p 3.12 .venv
uv pip install -p .venv/bin/python -r requirements.txt
.venv/bin/python -m unittest -v
```

## Environment

| Variable | Required | Use |
| --- | --- | --- |
| `TELLY_FETCH_AGENT_SEED` | yes, secret | The seed for the agent identity. The same seed gives the same agent address. |
| `TELLY_SERVER_URL` | yes | The http(s) base URL of the telly server. |
| `TELLY_FETCH_SERVER_TOKEN` | yes, secret | The bearer token of the worker for the telly server. |
| `TELLY_FETCH_GRANTS` | yes | A JSON object. Each key is a sender agent address. Each value is a list of family ids, for example `{"agent1q...": ["12"]}`. |
| `TELLY_FETCH_PORT` | no, default `8001` | The local HTTP port of the agent. |
| `TELLY_FETCH_MAILBOX` | no, default `true` | `true` connects the agent to an Agentverse mailbox. `false` turns off the mailbox and Almanac registration. Then only local clients can send to the agent. |

If a required variable is missing, the worker stops at start. The error message gives the variable name.

## Run with an Agentverse mailbox

1. Start the worker: `.venv/bin/python main.py`.
2. Open the "Agent inspector" URL from the log.
3. Sign in to Agentverse. Click **Connect**, then select **Mailbox**.

You do this one time for each agent address. You do not need an Agentverse API key in the environment. The browser sends your Agentverse session token to the local `/connect` endpoint of the agent.

In mailbox mode, the agent polls Agentverse for messages. It does not need an inbound port. Do not expose `TELLY_FETCH_PORT` to the internet.

## Run locally without Agentverse

```sh
TELLY_FETCH_MAILBOX=false .venv/bin/python main.py
```

The worker logs its address at start. In a second shell, send one call:

```sh
TELLY_FETCH_CLIENT_SEED=my-test-client .venv/bin/python send_tool_call.py \
  <worker address> 12 '{"tool":"alerts","input":{}}' --endpoint http://127.0.0.1:8001/submit
```

The client writes its own address to stderr. Add that address to `TELLY_FETCH_GRANTS`, then restart the worker. The client prints the `ToolResult` as JSON.

## Update the contract

Do not edit `contract.json` by hand. Generate it from the shared Effect Schema:

```sh
bun run --filter @health/contracts agent-contract
```
