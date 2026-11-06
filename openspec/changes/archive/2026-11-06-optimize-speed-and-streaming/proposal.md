# Proposal: Optimize Speed and Streaming Pipeline

## Why

External coding agents like OpenCode, Roo Code, and Cline suffer from high time-to-first-token (TTFT) latency (often 10–15 seconds on initial turns) and perceived freezes during tool execution. Empirical network probes revealed that:
1. OpenCode issues a title-generation request concurrently with Turn 1, triggering a double cold-start of two heavyweight `session/new` ACP sessions (~13.5s total wait).
2. Every new task Turn 1 synchronously blocks for ~3.8s on `acp.newSession`.
3. Tool call generation (such as file writes) buffers the entire JSON payload in memory until `</agy_tool_call>`, causing the client UI to appear frozen for 5–20s during code generation.
4. Tool schemas injected into system prompts are pretty-printed with multi-space indentation, unnecessarily inflating prompt prefill tokens.

Optimizing these areas removes up to 10 seconds of startup dead-wait and provides smooth, real-time code streaming during tool calls without degrading deep reasoning performance.

## What Changes

- **Automatic Fast Title/Utility Bypass**: Detect single-turn utility/title prompts (e.g., OpenCode title generator, tool-less summarizations) and serve them using a dedicated lightweight ACP session on the fastest available `-low` model (e.g. `gemini-3.8-flash-low`), cutting title latency from ~6.5s to ~300ms without polluting the agent session cache.
- **Background Session Pre-warming**: Maintain a background standby session pre-initialized for the current workspace/model configuration so Turn 1 of new conversations acquires a session in 0ms (saving ~3.8s).
- **Progressive Tool Argument Streaming**: Enhance `ToolStreamParser` to emit tool metadata immediately and stream `arguments` deltas incrementally into OpenAI `delta.tool_calls[0].function.arguments`, eliminating long silences during multi-line file writes.
- **Minified Injected Payloads**: Compact tool definitions in `buildSystemPromptAppend` using non-indented JSON, reducing prompt prefill overhead by ~3,000–5,000 characters per turn.

## Capabilities

### New Capabilities
- `speed-optimization`: Fast utility bypass routing, background session pre-warming pool, and progressive tool call streaming.

### Modified Capabilities
<!-- None: Greenfield project specs; no pre-existing capabilities registered in openspec/specs/. -->

## Impact

- **Affected Components**:
  - `src/session-manager.ts`: Background pre-warming pool and utility session management.
  - `src/server.ts`: Request inspection for utility/title routing and integration with pre-warmed sessions.
  - `src/tool-bridge.ts`: Progressive streaming parser for `<agy_tool_call>` argument deltas and minified tool serialization.
  - `src/acp-client.ts`: Helper methods for fast-model discovery and warm session replenishment.
  - `src/test.ts`: Automated tests verifying utility bypass, pre-warm reuse, and progressive tool streaming.
- **Backwards Compatibility**:
  - 100% backward compatible with existing OpenAI chat completion endpoints, SSE event streams, and agent mode.
