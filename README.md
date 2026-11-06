# `agy-openai-bridge`

An OpenAI-compatible HTTP/SSE server powered by Antigravity CLI's **Agent Client Protocol (`agy acp`)**.

Connect coding agents (**OpenCode**, **Roo Code**, **Cline**, **Continue**, **Aider**) or chat clients (**OpenWebUI**, **ChatBox**, **OpenAI SDK**) directly to your local `agy` installation.

---

## Features

- **Persistent `agy acp` Process**: Spawns `agy acp` once and multiplexes JSON-RPC 2.0 sessions over `stdio` with zero per-request cold-start overhead.
- **Background Session Pre-warming**: Pre-warms a standby ACP session in the background so Turn 1 of any new conversation or task starts in 0ms instead of blocking synchronously for ~3.8s.
- **Fast Title & Utility Bypass**: Automatically detects background utility requests (such as OpenCode thread title generators) and routes them to an isolated, persistent utility session on the fastest available `-low` model (`gemini-3.8-flash-low`, ~300ms), preventing double cold-starts and protecting the main agent session cache.
- **Progressive Tool Argument Streaming**: Streams tool call `function.arguments` incrementally via `delta.tool_calls[0].function.arguments` as chunks arrive from `agy`, eliminating client UI freezing during multi-line file writes and code generations.
- **Dual-Mode via Model ID**:
  - **Standard Mode (`<model>`, e.g. `claude-sonnet-5-5-high`, `gemini-4-argon-high`)**: Suppresses `agy`'s internal workspace tools and translates OpenAI `tools` / `tool_calls` so external coding agents (OpenCode, Roo Code, Cline, Continue) have full control over file edits and commands.
  - **Agent Mode (`<model>-agent`, e.g. `claude-sonnet-5-5-high-agent`)**: Lets `agy` execute its own built-in tools (`read_file`, `edit_file`, `run_command`, MCP servers) in the target workspace and streams tool activity into `reasoning_content`.
- **Smart Session Reuse with Fallback**: Hashes the conversation history prefix (`messages`) to reuse active ACP `sessionId`s on append-only turns (preserving prompt cache and low latency), and automatically starts a fresh ACP session if the client compacts or edits earlier messages.
- **Streaming Reasoning (`reasoning_content`)**: Streams `agent_thought_chunk` tokens (and `-agent` internal tool activity) via `delta.reasoning_content`.
- **Per-Request Workspace Override**: Set `X-Workspace-Dir: /path/to/repo` or pass `cwd=/path/to/repo` in the client's `apiKey` field to target different repositories without restarting the bridge.

---

## Installation & Quick Start

> **Prerequisite**: Make sure the Antigravity CLI (`agy`) is installed and authenticated on your machine (`which agy`).

### Run directly with `npx`

```bash
npx agy-openai-bridge --port 8787
```

### Or install globally via `npm`

```bash
npm install -g agy-openai-bridge
agy-openai-bridge --port 8787
```

### CLI Options

```text
Options:
  -p, --port <number>          Port to listen on (default: 8787 or $PORT)
  --host <address>             Host to bind (default: 127.0.0.1 or $HOST)
  --cwd <path>                 Default workspace directory for -agent mode (default: cwd)
  --api-key <key>              Optional Bearer API key required from clients ($API_KEY)
  --agy-bin <path>             Path to agy binary (default: agy)
  --include-customizations     Load default agy skills/MCPs in ACP sessions (default: false)
  -v, --verbose                Enable verbose ACP JSON-RPC logging
  -h, --help                   Show this help message
```

---

## Client Configuration Examples

### OpenCode (`~/.config/opencode/opencode.json`)

Add the `agy` provider to your `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "agy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Antigravity (agy)",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "not-needed"
      },
      "models": {
        "claude-opus-5-5-high": {
          "name": "Claude Opus 5.5 (High)",
          "tool_call": true,
          "reasoning": true,
          "limit": { "context": 200000, "output": 32768 }
        },
        "claude-sonnet-5-5-high": {
          "name": "Claude Sonnet 5.5 (High)",
          "tool_call": true,
          "reasoning": true,
          "limit": { "context": 200000, "output": 32768 }
        },
        "gemini-4-argon-high": {
          "name": "Gemini 4 Argon (High)",
          "tool_call": true,
          "reasoning": true,
          "limit": { "context": 1000000, "output": 65536 }
        },
        "gemini-3.8-flash-high": {
          "name": "Gemini 3.8 Flash (High)",
          "tool_call": true,
          "reasoning": true,
          "limit": { "context": 1000000, "output": 65536 }
        }
      }
    }
  }
}
```

### Roo Code / Cline / Continue
- **API Provider**: `OpenAI Compatible`
- **Base URL**: `http://127.0.0.1:8787/v1`
- **API Key**: `not-needed` (or `cwd=/path/to/my-app` when using `-agent` models)
- **Model ID**:
  - `claude-sonnet-5-5-high` / `gemini-4-argon-high` / `claude-opus-5-5-high` (Client runs tools)
  - `claude-sonnet-5-5-high-agent` / `gemini-4-argon-high-agent` (`agy` runs tools in workspace)

### cURL Example

```bash
# List available models
curl http://127.0.0.1:8787/v1/models

# Streaming chat completion
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-4-argon-high",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello from OpenAI bridge!"}
    ]
  }'
```

---

## Programmatic Library Usage (Node.js / TypeScript)

You can also embed `BridgeServer` or `AcpClient` directly in a Node.js or TypeScript application:

```ts
import { BridgeServer } from "agy-openai-bridge";

const server = new BridgeServer({
  port: 8787,
  host: "127.0.0.1",
  defaultCwd: process.cwd(),
  agyBin: "agy",
  includeDefaultCustomizations: false,
  maxCachedSessions: 50,
  verbose: false,
});

await server.start();
```

---

## Publishing Releases

### 1. Local CLI Publish

```bash
npm login
npm publish --access public
```

(`prepublishOnly` automatically runs `npm run build && npm test` before packaging.)

### 2. GitHub Actions Release (Automated on `v*` Tags)

1. Add an npm granular access token as `NPM_TOKEN` in your GitHub repository's **Settings → Secrets and variables → Actions**.
2. Bump the version and push the tag:
   ```bash
   npm version patch # or minor / major
   git push origin main --follow-tags
   ```

---

## License

[MIT](./LICENSE) © Arif Widipratomo
