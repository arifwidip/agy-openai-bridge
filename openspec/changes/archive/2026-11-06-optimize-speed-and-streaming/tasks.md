# Tasks: Speed Optimization and Streaming Pipeline

## 1. Minified Injections and Progressive Tool Streaming

- [x] 1.1 Minify tool schema serialization in `src/tool-bridge.ts` by removing 2-space indentation and verify payload size reduction.
- [x] 1.2 Implement progressive tool argument streaming state machine in `ToolStreamParser` (`src/tool-bridge.ts`) to emit `delta.tool_calls` argument deltas in real-time.
- [x] 1.3 Add unit tests in `src/test.ts` validating progressive tool argument streaming and tag flush resilience.

## 2. Fast Title and Utility Bypass Engine

- [x] 2.1 Add fast model discovery in `src/acp-client.ts` to dynamically resolve the fastest available `-low` model.
- [x] 2.2 Implement utility prompt detection and dedicated singleton utility session handling in `src/server.ts` and `src/session-manager.ts`.
- [x] 2.3 Add tests in `src/test.ts` verifying that title generator requests route to the utility engine without disrupting the primary session cache.

## 3. Background Standby Session Pre-warming

- [x] 3.1 Implement standby session tracking and asynchronous background replenishment in `src/session-manager.ts`.
- [x] 3.2 Wire `BridgeServer` request dispatching to claim matching pre-warmed standby sessions on initial conversation turns.
- [x] 3.3 Add tests in `src/test.ts` verifying standby session handoff and automatic replenishment.

## 4. Integration Verification and Documentation

- [x] 4.1 Run TypeScript compilation and full test suite (`npm run build && npm test`) to ensure zero regressions.
- [x] 4.2 Update `README.md` with performance benchmarks, title bypass details, and progressive streaming notes.
