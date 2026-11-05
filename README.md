# `agy-openai-bridge`

An OpenAI-compatible HTTP/SSE server powered by Antigravity CLI's **Agent Client Protocol (`agy acp`)**.

Connect coding agents (**Roo Code**, **Cline**, **OpenCode**, **Continue**, **Aider**) or chat clients (**OpenWebUI**, **ChatBox**, **OpenAI SDK**) directly to your local `agy` installation.

---

## Features

- **Persistent `agy acp` Process**: Spawns `agy acp` once and multiplexes JSON-RPC 2.0 sessions over `stdio` with zero per-request cold-start overhead.
- **Dual-Mode via Model ID**:
  - **Standard Mode (`<model>`, e.g. `claude-sonnet-5-5-high`, `gemini-4-argon-high`)**: Suppresses `agy`'s internal workspace tools and translates OpenAI `tools` / `tool_calls` so external coding agents (Roo Code, Cline, OpenCode, Continue) have full control over file edits and commands.
  - **Agent Mode (`<model>-agent`, e.g. `claude-sonnet-5-5-high-agent`)**: Lets `agy` execute its own built-in tools (`read_file`, `edit_file`, `run_command`, MCP servers) in the target workspace and streams tool activity into `reasoning_content`.
- **Smart Session Reuse with Fallback**: Hashes the conversation history prefix (`messages`) to reuse active ACP `sessionId`s on append-only turns (preserving prompt cache and low latency), and automatically starts a fresh ACP session if the client compacts or edits earlier messages.
- **Streaming Reasoning (`reasoning_content`)**: Streams `agent_thought_chunk` tokens (and `-agent` internal tool activity) via `delta.reasoning_content`.
- **Per-Request Workspace Override**: Set `X-Workspace-Dir: /path/to/repo` or pass `cwd=/path/to/repo` in the client's `apiKey` field to target different repositories without restarting the bridge.

---

## Quick Start

```bash
cd /Users/arif/Projects/agy-openai-bridge
npm install
npm run build
npm start
```

Or link globally so you can run `agy-openai-bridge` from anywhere:

```bash
npm link
agy-openai-bridge --port 8787
```

---

## Client Configuration Examples

### Roo Code / Cline / Continue / OpenCode
- **API Provider**: `OpenAI Compatible`
- **Base URL**: `http://127.0.0.1:8787/v1`
- **API Key**: `not-needed` (or `cwd=/Users/arif/Projects/my-app` when using `-agent` models)
- **Model ID**:
  - `claude-sonnet-5-5-high` / `gemini-4-argon-high` / `claude-opus-5-5-high` (Client runs tools)
  - `claude-sonnet-5-5-high-agent` / `gemini-4-argon-high-agent` (`agy` runs tools in workspace)

### cURL Example

```bash
# List available models
curl http://127.0.0.1:8787/v1/models

# Streaming chat completion
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-4-argon-high",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello from OpenAI bridge!"}
    ]
  }'
```
