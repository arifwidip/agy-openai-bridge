# speed-optimization Specification

## Purpose

Provides high-throughput and low-latency execution for OpenAI-compatible chat completion requests by eliminating cold-start session delays, bypassing utility requests, and streaming tool call arguments progressively.

## Requirements

### Requirement: Fast Utility and Title Bypass
The bridge SHALL detect single-turn utility requests (such as thread title generation or short tool-less summarizations) and route them to an isolated, persistent utility session powered by the fastest available `-low` model without allocating or interrupting main conversation sessions.

#### Scenario: OpenCode title generation request
- **WHEN** a client sends a chat completion request containing a title generation system instruction and no client tools
- **THEN** the bridge executes the completion using a dedicated lightweight utility session with the fastest available `-low` model and completes the request in sub-second time without creating a new full agent session

#### Scenario: Normal agent prompt bypassing utility routing
- **WHEN** a client sends a chat completion request containing client tools or standard conversational instructions
- **THEN** the bridge routes the request through the primary conversation session manager rather than the utility bypass

---

### Requirement: Background Session Pre-warming
The bridge SHALL maintain a background standby ACP session ready for the current workspace and configuration, allowing initial turns (Turn 1) of new conversation tasks to acquire a session immediately without blocking synchronously on session creation.

#### Scenario: New task turn 1 claims pre-warmed session
- **WHEN** a client sends the first turn of a new conversation that requires a new ACP session
- **THEN** the bridge immediately assigns the pre-warmed standby session, skipping the synchronous ~3.8s session initialization delay

#### Scenario: Asynchronous replenishment of standby session
- **WHEN** an active request acquires the standby pre-warmed session
- **THEN** the bridge asynchronously initiates creation of the next standby session in the background without delaying the active request

---

### Requirement: Progressive Tool Argument Streaming
The bridge SHALL parse `<agy_tool_call>` tags from model output streams and progressively emit `delta.tool_calls` chunks containing incremental `function.arguments` updates to the SSE client, rather than buffering the entire argument payload until the closing tag.

#### Scenario: Progressive argument delivery during large tool call
- **WHEN** the model generates a tool call containing extensive arguments (such as writing or editing file contents)
- **THEN** the bridge emits the tool name in the initial chunk and continuously streams argument deltas to the client as chunks arrive from ACP

#### Scenario: Finalization of tool call
- **WHEN** the model finishes emitting the closing `</agy_tool_call>` tag
- **THEN** the bridge finalizes the tool call turn and sets `finish_reason: "tool_calls"`

---

### Requirement: Minified Injected Payloads
The bridge SHALL format client tool definitions and system instructions using compact, non-indented JSON to minimize prompt token count and prefill latency.

#### Scenario: Client tool definitions injection
- **WHEN** client tools are provided in a chat completion request
- **THEN** the injected system prompt contains minified JSON tool specifications without extra whitespace indentation
