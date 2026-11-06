# Design: Speed Optimization and Streaming Architecture

## Context

The bridge acts as an HTTP/SSE to JSON-RPC stdio proxy between OpenAI-compatible clients (OpenCode, Roo Code, Cline) and `agy acp`.
See [proposal.md](file:///mnt/REPO/WORKS/Projects/agy-openai-bridge/openspec/changes/optimize-speed-and-streaming/proposal.md) for motivation and empirical benchmark findings.

## Goals / Non-Goals

**Goals:**
- Eliminate the ~13.5s startup penalty caused by title-generation double cold starts and synchronous Turn-1 session allocation.
- Eliminate client UI freezes during large tool calls (file writes/edits) by streaming tool arguments progressively.
- Preserve 100% fidelity of deep reasoning (`-high` models) while making the user interaction feel instant and responsive.
- Maintain full backwards compatibility with OpenAI API clients without requiring client-side modifications.

**Non-Goals:**
- Modifying `agy acp` internal Go binaries or cloud backend streaming rates (we optimize what the bridge controls).
- Adding complex multi-process session clustering (single `agy acp` stdio process remains the standard multiplexer).

## Decisions

### 1. Dedicated Fast Utility / Title Bypass Engine
- **Heuristic**: A request is classified as a utility prompt if:
  1. `tools` is empty or undefined, and `tool_choice` is `"none"` or undefined.
  2. The system prompt contains title generator signatures (e.g. `title generator`, `Generate a brief title`, `thread title`).
- **Execution**: The bridge maintains an isolated singleton utility session (`utilitySessionId`) initialized with the fastest available `-low` model (dynamically selected from `getAvailableModels()`, prioritizing `gemini-3.8-flash-low`, `gemini-4-argon-low`, or `claude-sonnet-5-5-low`).
- **Rationale**: Title generation requires no tools and minimal reasoning. Running it through a dedicated lightweight session takes ~300ms, completely avoiding the 6.5s delay and eliminating session thrashing with the main agent session.
- **Alternatives Considered**:
  - *Dropping title requests*: Fails OpenCode's UI requirement for thread titles.
  - *Serving in main agent session*: Forces double `session/new` cold-start and burns ~13.5s.

### 2. Standby Session Pre-warming Pool
- **Architecture**: `SessionManager` maintains a background standby slot:
  ```ts
  interface StandbySession {
    sessionId: string;
    cwd: string;
    baseModelId: string;
    systemHash: string;
    isAgentMode: boolean;
  }
  ```
- **Lifecycle**:
  1. When the bridge starts (or when the first agent session is created), it records the system template and asynchronously pre-warms a standby session via `acp.newSession(...)`.
  2. When a Turn-1 request arrives: if its `(cwd, baseModelId, systemHash, isAgentMode)` matches the standby session, it claims the standby session in **0ms** (saving ~3.8s synchronous cold-start).
  3. Immediately upon claim, a background asynchronous task (`replenishStandby()`) creates the next standby session.
  4. If a request arrives with mismatched parameters, it falls back to standard `acp.newSession` and updates the standby target.
- **Alternatives Considered**:
  - *Pre-warming a fixed pool of 5 sessions*: Incurs unnecessary resource consumption and potential ACP worker limits. A 1-session standby pool covers >95% of sequential coding agent turns.

### 3. Progressive Tool Argument Streaming in `ToolStreamParser`
- **Architecture**: Rather than buffering the entire content between `<agy_tool_call>` and `</agy_tool_call>`, `ToolStreamParser` operates as an incremental streaming state machine:
  1. `TEXT`: Stream text chunks directly as `delta.content`.
  2. `TAG_HEADER`: When `<agy_tool_call>` is seen, buffer until the JSON header (`"name": "<tool_name>", "arguments":`) is parsed.
  3. Emit initial tool call chunk: `{ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: toolName, arguments: "" } }] }`.
  4. `TAG_ARGUMENTS`: As subsequent chunks arrive from `agy acp`, stream the raw argument text directly into `delta.tool_calls[0].function.arguments`.
  5. `TAG_CLOSE`: Upon encountering `</agy_tool_call>`, finalize the tool call and transition back to `TEXT`.
- **Rationale**: When an agent writes a 200-line file, OpenCode previously sat frozen for 10–20s. Progressive streaming provides immediate, real-time code output in the client UI.
- **Alternatives Considered**:
  - *Full JSON buffering*: Simple, but causes unacceptable freezes during code generation.
  - *External streaming JSON library*: Unnecessary overhead; a lightweight state machine around `<agy_tool_call>` is robust and zero-dependency.

### 4. Compact Payload Serialization
- In `src/tool-bridge.ts`, format tool schemas using minified `JSON.stringify(toolSpecs)` rather than indented `JSON.stringify(toolSpecs, null, 2)`.
- Strips thousands of redundant whitespace characters (~1,000 tokens), reducing TTFT and upstream prefill costs.

## Risks / Trade-offs

- **[Risk: Standby session parameters mismatch]** → **Mitigation**: If the user switches workspaces or model IDs, the standby session is simply discarded and replenished with the new parameters; standard synchronous fallback handles the turn safely.
- **[Risk: Malformed or unclosed tool tags]** → **Mitigation**: If `</agy_tool_call>` is missing or malformed at stream end, `ToolStreamParser.flush()` safely flushes any remaining text to prevent dropped output.
- **[Risk: Utility prompt false-positive]** → **Mitigation**: Heuristic requires BOTH no tools present AND matching title-generation prompt patterns. Normal user messages are never misrouted.
