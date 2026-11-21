# A2A server facade over the Snapgent browser bridge

The bridge already drives a free web AI chat through the browser extension. The
A2A facade exposes that same chat as an **A2A 1.0** agent: a local client
discovers it, sends a prompt, polls the task, or streams the result over HTTP
and JSON-RPC 2.0. The extension keeps doing all DOM work; `a2a_server.py` only
adds a thin, loopback-only HTTP layer in the same process as `bridge.py`.

Per-provider modes, limits and observed behavior live in
[`WEB_AI_CAPABILITIES.md`](WEB_AI_CAPABILITIES.md).

## Data flow

```
A2A client ──HTTP/JSON-RPC──> a2a_server.py ──asyncio callback──> bridge.py
                                                                    │ WebSocket
                                                                    ▼
                                                    background.js (service worker)
                                                                    │ tabs.sendMessage
                                                                    ▼
                                                            core/main.js (content script)
                                                                    │ DOM
                                                                    ▼
                                                       ChatGPT / Claude / Gemini / ...
```

`a2a_server.py` runs a `ThreadingHTTPServer` on `127.0.0.1:17614` in a daemon
thread. It never touches the browser. To run a prompt it calls an injected
callable that schedules `Bridge.submit_prompt` on the bridge's asyncio loop.

## Run

```
bash Linux_Start.sh
```

`Linux_Start.sh` runs `python3 bridge.py` in the foreground. At startup the
bridge prints the A2A endpoint and the bearer token to the terminal:

```
A2A agent card: http://127.0.0.1:17614/.well-known/agent-card.json
A2A bearer token: <token>
```

The token goes to `~/.snapgent/a2a_token` and the terminal, never to
`logs/bridge_debug.log`.
Keep the terminal open while you use the agent.

## Authenticate

Every `POST /` needs the bearer token. The bridge keeps it in
`~/.snapgent/a2a_token` (mode `600`, directory `700`, reused across restarts) and
also prints it, so a local agent reads the file instead of copying anything:

```
export ZS_A2A_TOKEN=$(cat ~/.snapgent/a2a_token)
```

The Agent Card is public and needs no token:

```
curl -s http://127.0.0.1:17614/.well-known/agent-card.json
```

`GET /.well-known/agent.json` returns the same card for pre-1.0 clients. Missing
or wrong token returns HTTP 401 with `WWW-Authenticate: Bearer`.

## Send a prompt (blocking)

`SendMessage` returns when the task reaches `TASK_STATE_COMPLETED` or
`TASK_STATE_FAILED`. The model runs to completion: it may make many MCP tool
round-trips before it answers.

```
curl -s -X POST http://127.0.0.1:17614/ \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ZS_A2A_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "msg-1",
        "role": "ROLE_USER",
        "parts": [{"text": "List the files in the repo root and describe what each one does."}]
      }
    }
  }'
```

The `result` is a `Task`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "task-5cdc4ad575f040eba418350128c09d1a",
    "contextId": "ctx-0bb3f629efdd469085d1ed742d3070c1",
    "status": {
      "state": "TASK_STATE_COMPLETED",
      "timestamp": "2026-11-04T11:47:35.719417+00:00",
      "message": {
        "messageId": "msg-f2bccf3726c441ba8fa4bb1553f532a5",
        "role": "ROLE_AGENT",
        "parts": [{"text": "..."}],
        "taskId": "task-5cdc4ad575f040eba418350128c09d1a",
        "contextId": "ctx-0bb3f629efdd469085d1ed742d3070c1"
      }
    },
    "artifacts": [
      {
        "artifactId": "artifact-83a2824bd0304f31b75caa0d0be3caff",
        "name": "reply",
        "parts": [{"text": "..."}]
      }
    ],
    "history": [
      {"messageId": "msg-1", "role": "ROLE_USER", "parts": [{"text": "List the files ..."}]},
      {"messageId": "msg-f2bccf3726c441ba8fa4bb1553f532a5", "role": "ROLE_AGENT", "parts": [{"text": "..."}], "taskId": "task-5cdc4ad575f040eba418350128c09d1a", "contextId": "ctx-0bb3f629efdd469085d1ed742d3070c1"}
    ],
    "metadata": {}
  }
}
```

The prompt text is the concatenation of every `Part` with a string `text`
member. A message with no text part returns JSON-RPC error `-32602`.

## Return immediately and poll

Set `configuration.returnImmediately` to `true` to get the task while it is
still `TASK_STATE_SUBMITTED`, then poll `GetTask`. `configuration.historyLength`
trims the returned `history` array in the same response.

```
curl -s -X POST http://127.0.0.1:17614/ \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ZS_A2A_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "msg-2",
        "role": "ROLE_USER",
        "parts": [{"text": "List the files in the repo root and describe what each one does."}]
      },
      "configuration": {"returnImmediately": true}
    }
  }'
```

Poll with the returned `result.id`:

```
curl -s -X POST http://127.0.0.1:17614/ \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ZS_A2A_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "GetTask",
    "params": {"id": "task-5cdc4ad575f040eba418350128c09d1a"}
  }'
```

`GetTask` returns the same `Task` shape. Add `"historyLength": 0` to the params
to get an empty `history`. An unknown id returns JSON-RPC error `-32001`
(`Task not found`).

The A2A v0.3 aliases `message/send`, `message/stream`, and `tasks/get` route to
the same handlers. Responses are always 1.0 shapes.

## Stream

`SendStreamingMessage` returns `Content-Type: text/event-stream` and emits three
`data:` events in order: the working task, the artifact, then the terminal
status. Use `-N` so curl does not buffer.

```
curl -sN -X POST http://127.0.0.1:17614/ \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ZS_A2A_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "SendStreamingMessage",
    "params": {
      "message": {
        "messageId": "msg-3",
        "role": "ROLE_USER",
        "parts": [{"text": "List the files in the repo root and describe what each one does."}]
      }
    }
  }'
```

```
data: {"task": {"id": "task-1fdbb7eaddbf4bc0baa41c1f6df7d3cb", "contextId": "ctx-a631c17f26e24ce1a4bda6d30b88698b", "status": {"state": "TASK_STATE_WORKING", "timestamp": "2026-11-04T11:47:35.794425+00:00"}, "artifacts": [], "history": [{"messageId": "msg-3", "role": "ROLE_USER", "parts": [{"text": "List the files ..."}]}], "metadata": {}}}

data: {"artifactUpdate": {"taskId": "task-1fdbb7eaddbf4bc0baa41c1f6df7d3cb", "contextId": "ctx-a631c17f26e24ce1a4bda6d30b88698b", "artifact": {"artifactId": "artifact-73b658002c2b44bf80024774dcda9fd4", "name": "reply", "parts": [{"text": "..."}]}, "index": 0}}

data: {"statusUpdate": {"taskId": "task-1fdbb7eaddbf4bc0baa41c1f6df7d3cb", "contextId": "ctx-a631c17f26e24ce1a4bda6d30b88698b", "status": {"state": "TASK_STATE_COMPLETED", "timestamp": "2026-11-04T11:47:35.794769+00:00", "message": {"messageId": "msg-f6aa88b9c0a84b328d66dafdb89d2ddf", "role": "ROLE_AGENT", "parts": [{"text": "..."}], "taskId": "task-1fdbb7eaddbf4bc0baa41c1f6df7d3cb", "contextId": "ctx-a631c17f26e24ce1a4bda6d30b88698b"}}}}
```

On failure the stream emits the same working-task event, then one
`statusUpdate` with `TASK_STATE_FAILED`.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `ZS_A2A_PORT` | `17614` | HTTP listen port |
| `ZS_A2A_TOKEN` | random | Bearer token; generated with `secrets.token_urlsafe(32)` and printed when unset |
| `ZS_A2A_TIMEOUT_MS` | `600000` | Task timeout (10 min) |
| `ZS_A2A_DISABLE` | unset | `1` skips starting the A2A server |

Set them before `bash Linux_Start.sh`, for example:

```
ZS_A2A_PORT=19000 ZS_A2A_TOKEN=my-token bash Linux_Start.sh
```

## Methods

| Method (aliases) | Params | Result |
| --- | --- | --- |
| `SendMessage` (`message/send`) | `SendMessageRequest` | `Task` |
| `SendStreamingMessage` (`message/stream`) | `SendMessageRequest` | SSE stream |
| `GetTask` (`tasks/get`) | `{id, historyLength}` | `Task` |

## Errors

| Condition | Result |
| --- | --- |
| No token / wrong token | HTTP 401 |
| No extension connected | task `TASK_STATE_FAILED`, message `No Snapgent extension is connected.` |
| Empty prompt | task `TASK_STATE_FAILED`, message `Empty prompt.` |
| Task timeout | task `TASK_STATE_FAILED`, message `The web AI did not answer within <N>s.` |
| Model failure | task `TASK_STATE_FAILED`, message from the content script |
| Unknown `GetTask` id | JSON-RPC `-32001` |
| Message with no text part | JSON-RPC `-32602` |
| Unknown method | JSON-RPC `-32601` |
| Malformed JSON | JSON-RPC `-32700` |
| Invalid request | JSON-RPC `-32600` |

## Limits

- Binds `127.0.0.1` only. No remote access.
- Bearer token required on every `POST /`. The endpoint drives a logged-in
  browser session and can write workspace files, so it is never unauthenticated.
- Concurrency 1. All three methods funnel through `Bridge.submit_prompt`, which
  serialises on an `asyncio.Lock`. A second task waits for the first.
- The chat tab must be the **foreground tab** of its window. A backgrounded tab
  pauses the loop.
- Default task timeout 600 s (`ZS_A2A_TIMEOUT_MS`).
- No push notifications (`pushNotifications: false` in the card).
- No task cancel. The extension cannot interrupt a generation cleanly, so
  `tasks/cancel` is not implemented.
- The extension websocket on `ws://127.0.0.1:17613` is not authenticated. The
  bridge sends a prompt to a single socket and accepts its reply only from that
  socket, but a local process that connects can still interfere. See the Risks
  section of `docs/a2a-design.md`.

## Supported local clients

The A2A endpoint is meant for local coding harnesses: **Hermes** (primary),
OpenCode, Freebuff, Claude Code and Antigravity. An A2A 1.0 client needs only the
Agent Card, the bearer token and `SendMessage`; no adapter or protocol shim is
needed. Hermes' `a2a` toolset was verified end to end: it fetches the v1.0 card,
selects the JSONRPC interface from `supportedInterfaces`, sends
`A2A-Version: 1.0`, and accepts the bare `Task` this server returns.

### Hermes

Register the bridge as a peer under `a2a_agents` in Hermes `config.yaml`:

```yaml
a2a_agents:
  webmcp:
    url: http://127.0.0.1:17614
    auth:
      type: bearer
      token: "<contents of ~/.snapgent/a2a_token>"
    timeout: 600
```

`timeout` is in seconds and defaults to 120 in Hermes. Set it at or above
`ZS_A2A_TIMEOUT_MS` (default 600000 ms); otherwise Hermes gives up on a slow
provider while the task keeps running here. Then call `a2a_call` with
`agent: webmcp`.

### Other harnesses

Point the client at `http://127.0.0.1:17614`, read the bearer token from
`~/.snapgent/a2a_token`, and send `SendMessage` with `metadata.provider` set to
the web AI to use. Use a timeout of at least 600 seconds. The v0.3 method
aliases are accepted as well.

Routing may also be steered with capability metadata. All four flags are
optional; omitting them keeps the default routing:

```
curl -s -X POST http://127.0.0.1:17614/ \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ZS_A2A_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "SendMessage",
    "params": {
      "metadata": {
        "needsVision": true,
        "needsWeb": true,
        "largeInput": true,
        "avoidProviders": ["claude"]
      },
      "message": {
        "messageId": "msg-4",
        "role": "ROLE_USER",
        "parts": [{"text": "Describe this screenshot and verify it against the live site."}]
      }
    }
  }'
```

See `docs/model-routing.md` for the flags, their filter order, and the
`capabilityFallback` behaviour when no provider qualifies.

### Verified web AI modes

The focused targets are Gemini 4 Hydrogen with thinking level High, DeepSeek
with DeepThink and web Search on, and ChatGPT with Think on. Set the DeepSeek
and ChatGPT modes in the site UI before starting the bridge. Gemini's adapter
restores 4 Hydrogen + High at session startup; DeepSeek's adapter leaves Search
as the user set it.

## Testing

Offline (no browser, no network):

```
python3 -m unittest discover -s tests
node snapgent-extension/test-a2a.js
```

Live, against the real providers through a running bridge and a CDP browser:

```
python3 e2e/a2a_matrix_live.py --rounds 2 --timeout 540
python3 e2e/a2a_matrix_live.py --only claude,rudder --rounds 1
```

The matrix opens every provider tab fresh (a cold start, which is the case that
used to fail), sends the one-word prompt with `metadata.provider` pinned, and
prints a per-provider line plus a STABLE / NOT STABLE verdict across rounds.
`--cdp` is the CDP port (default `9222`); `--only` narrows the provider set
to the comma-separated names the runner knows.
