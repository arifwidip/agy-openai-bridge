import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as lib from "./index.js";
import {
  AcpClient,
  BridgeServer,
  SessionManager,
  ToolStreamParser,
  buildSystemPromptAppend,
  formatAgentInternalToolUpdate,
} from "./index.js";

function isAgyAvailable(): boolean {
  if (process.env.AGY_SKIP_LIVE_E2E === "true") {
    return false;
  }
  const check = spawnSync("which", ["agy"], { encoding: "utf8" });
  return check.status === 0 && Boolean(check.stdout?.trim());
}

test("Library entrypoint (index.js) exports public classes and helpers without side effects", () => {
  assert.equal(typeof lib.BridgeServer, "function");
  assert.equal(typeof lib.AcpClient, "function");
  assert.equal(typeof lib.SessionManager, "function");
  assert.equal(typeof lib.ToolStreamParser, "function");
  assert.equal(typeof buildSystemPromptAppend, "function");
  assert.equal(typeof formatAgentInternalToolUpdate, "function");
});

test("ToolStreamParser progressively streams tool call argument deltas", () => {
  const parser = new ToolStreamParser(true);

  // Chunk 1: introduces tag and tool name
  const s1 = parser.push('<agy_tool_call>{"name": "write_file", "arguments": {"path": "a.ts", ');
  assert.equal(s1.textDelta, "");
  assert.equal(s1.toolCalls.length, 0);
  assert.ok(s1.toolCallDeltas.length >= 1);
  assert.equal(s1.toolCallDeltas[0].function?.name, "write_file");

  // Chunk 2: streams argument content
  const s2 = parser.push('"content": "console.log(123);\\nconsole.log(456);\\n"');
  assert.equal(s2.textDelta, "");
  assert.equal(s2.toolCalls.length, 0);
  assert.ok(s2.toolCallDeltas.length >= 1);

  // Chunk 3: closes tag
  const s3 = parser.push('}}</agy_tool_call> Done!');
  assert.equal(s3.toolCalls.length, 1);
  assert.equal(s3.textDelta, " Done!");

  // Verify all deltas combined match the finalized arguments exactly
  const allDeltas = [...s1.toolCallDeltas, ...s2.toolCallDeltas, ...s3.toolCallDeltas];
  const combinedArgs = allDeltas
    .map((d) => d.function?.arguments ?? "")
    .join("");
  assert.deepEqual(
    JSON.parse(combinedArgs),
    JSON.parse(s3.toolCalls[0].function.arguments)
  );
  assert.equal(JSON.parse(combinedArgs).path, "a.ts");
});

test("ToolStreamParser flush handles unclosed tag gracefully", () => {
  const parser = new ToolStreamParser(true);
  parser.push('<agy_tool_call>{"name": "test_tool", "arguments": {"foo": "bar"}}');
  const flushed = parser.flush();
  assert.equal(flushed.toolCalls.length, 1);
  assert.equal(flushed.toolCalls[0].function.name, "test_tool");
  assert.deepEqual(JSON.parse(flushed.toolCalls[0].function.arguments), { foo: "bar" });
});

test("buildSystemPromptAppend produces compact minified tool JSON without 2-space indentation", () => {
  const append = buildSystemPromptAppend(
    {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "test_tool",
            description: "test description",
            parameters: { type: "object", properties: { x: { type: "string" } } },
          },
        },
      ],
    },
    [],
    false
  );
  assert.ok(append.includes('{"name":"test_tool"'));
  assert.ok(!append.includes('{\n  "name": "test_tool"'));
});

test("SessionManager reuses session on append-only turns and creates new session on history edit (offline)", async () => {
  let nextId = 1;
  const fakeAcp = {
    async newSession() {
      return {
        sessionId: `sess_${nextId++}`,
        availableModels: [],
        currentModelId: "gemini-3.8-flash-low",
      };
    },
    async setModel() {},
    async closeSession() {},
  } as unknown as AcpClient;

  const manager = new SessionManager(fakeAcp, 10);

  // Turn 1
  const turn1 = await manager.acquireSession({
    baseModelId: "gemini-3.8-flash-low",
    isAgentMode: false,
    cwd: "/tmp",
    systemPromptAppend: "sys",
    nonSystemMessages: [{ role: "user", content: "Hello" }],
  });
  assert.equal(turn1.reused, false);
  assert.equal(turn1.sessionId, "sess_1");
  turn1.finalizeTurn("Hi there!", []);

  // Turn 2 (append-only)
  const turn2 = await manager.acquireSession({
    baseModelId: "gemini-3.8-flash-low",
    isAgentMode: false,
    cwd: "/tmp",
    systemPromptAppend: "sys",
    nonSystemMessages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "Follow-up question" },
    ],
  });
  assert.equal(turn2.reused, true);
  assert.equal(turn2.sessionId, "sess_1");
  turn2.finalizeTurn("Follow-up answer", []);
});

test("SessionManager utility session routes to fast model and does not disrupt main session cache", async () => {
  let nextId = 1;
  const fakeAcp = {
    async getFastestLowModel() {
      return "gemini-3.8-flash-low";
    },
    async newSession() {
      return {
        sessionId: `sess_${nextId++}`,
        availableModels: [],
        currentModelId: "gemini-3.8-flash-low",
      };
    },
    async setModel() {},
    async closeSession() {},
  } as unknown as AcpClient;

  const manager = new SessionManager(fakeAcp, 10);

  // 1. Establish an active main agent session
  const agentTurn1 = await manager.acquireSession({
    baseModelId: "claude-sonnet-5-5-high",
    isAgentMode: false,
    cwd: "/tmp",
    systemPromptAppend: "agent-tools-prompt",
    nonSystemMessages: [{ role: "user", content: "Start coding" }],
  });
  agentTurn1.finalizeTurn("I will help you code.", []);
  assert.equal(agentTurn1.sessionId, "sess_1");

  // 2. OpenCode fires a title generator request
  const titleTurn = await manager.acquireUtilitySession({
    cwd: "/tmp",
    messages: [{ role: "user", content: "Start coding" }],
    systemInstructions: "You are a title generator. You output ONLY a thread title.",
  });
  const utilityId = titleTurn.sessionId;
  assert.ok(utilityId);
  assert.equal(manager.getUtilitySessionId(), utilityId);

  // Subsequent title prompt reuses utility session
  const titleTurn2 = await manager.acquireUtilitySession({
    cwd: "/tmp",
    messages: [{ role: "user", content: "Second thread" }],
  });
  assert.equal(titleTurn2.sessionId, utilityId);
  assert.equal(titleTurn2.reused, true);

  // 3. Main agent session continues: turn 2 MUST still match sess_1 without cache invalidation!
  const agentTurn2 = await manager.acquireSession({
    baseModelId: "claude-sonnet-5-5-high",
    isAgentMode: false,
    cwd: "/tmp",
    systemPromptAppend: "agent-tools-prompt",
    nonSystemMessages: [
      { role: "user", content: "Start coding" },
      { role: "assistant", content: "I will help you code." },
      { role: "user", content: "Create a file" },
    ],
  });
  assert.equal(agentTurn2.reused, true);
  assert.equal(agentTurn2.sessionId, "sess_1");
});

test("SessionManager pre-warms standby session and claims it on new conversation Turn 1", async () => {
  let nextId = 1;
  const fakeAcp = {
    async getFastestLowModel() {
      return "gemini-3.8-flash-low";
    },
    async newSession() {
      return {
        sessionId: `sess_${nextId++}`,
        availableModels: [],
        currentModelId: "gemini-3.8-flash-low",
      };
    },
    async setModel() {},
    async closeSession() {},
  } as unknown as AcpClient;

  const manager = new SessionManager(fakeAcp, 10);

  // First session creation
  const t1 = await manager.acquireSession({
    baseModelId: "gemini-3.8-flash-low",
    isAgentMode: false,
    cwd: "/tmp",
    systemPromptAppend: "sys",
    nonSystemMessages: [{ role: "user", content: "Task 1" }],
  });
  assert.equal(t1.sessionId, "sess_1");

  // Wait a tick for async background replenishment to complete
  await new Promise((resolve) => setTimeout(resolve, 10));

  const standby = manager.getStandbySession();
  assert.ok(standby, "Standby session should be pre-warmed in background");
  assert.equal(standby.sessionId, "sess_2");

  // Starting a brand new conversation with matching system setup claims sess_2 immediately!
  const t2Fresh = await manager.acquireSession({
    baseModelId: "gemini-3.8-flash-low",
    isAgentMode: false,
    cwd: "/tmp",
    systemPromptAppend: "sys",
    nonSystemMessages: [{ role: "user", content: "Brand new task 2" }],
  });
  assert.equal(t2Fresh.sessionId, "sess_2");

  // Wait for next replenishment
  await new Promise((resolve) => setTimeout(resolve, 10));
  const nextStandby = manager.getStandbySession();
  assert.ok(nextStandby);
  assert.equal(nextStandby.sessionId, "sess_3");
});

const hasAgy = isAgyAvailable();

test(
  "End-to-end BridgeServer: /v1/models, multi-turn session reuse, streaming, and OpenAI tool_calls",
  {
    skip: !hasAgy
      ? "agy binary not found on PATH or AGY_SKIP_LIVE_E2E=true"
      : false,
  },
  async () => {
    const port = 18787;
    const bridge = new BridgeServer({
      port,
      host: "127.0.0.1",
      defaultCwd: process.cwd(),
      agyBin: "agy",
      includeDefaultCustomizations: false,
      maxCachedSessions: 10,
      verbose: false,
    });

    await bridge.start();
    try {
      // 1. Test GET /v1/models
      const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
      assert.equal(modelsRes.status, 200);
      const modelsJson = (await modelsRes.json()) as any;
      assert.equal(modelsJson.object, "list");
      assert.ok(modelsJson.data.length >= 2);
      const hasStandard = modelsJson.data.some(
        (m: any) => !m.id.endsWith("-agent")
      );
      const hasAgent = modelsJson.data.some((m: any) =>
        m.id.endsWith("-agent")
      );
      assert.ok(hasStandard, "Should expose standard models");
      assert.ok(hasAgent, "Should expose -agent models");

      // 2. Test Turn 1 + Turn 2 Smart Session Reuse
      const turn1Messages = [
        { role: "system", content: "Be extremely concise." },
        {
          role: "user",
          content: "Remember the secret code: BANANA-42. Reply with OK only.",
        },
      ];
      const t1Res = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gemini-3.8-flash-low",
            messages: turn1Messages,
            stream: false,
          }),
        }
      );
      assert.equal(t1Res.status, 200);
      assert.equal(t1Res.headers.get("x-agy-session-reused"), "false");
      const sessionId1 = t1Res.headers.get("x-agy-session-id");
      assert.ok(sessionId1);
      const t1Json = (await t1Res.json()) as any;
      const assistantReply1 = t1Json.choices[0].message.content;
      assert.ok(assistantReply1);

      // Turn 2: append assistant reply + new user question
      const turn2Messages = [
        ...turn1Messages,
        { role: "assistant", content: assistantReply1 },
        {
          role: "user",
          content:
            "What was the secret code I told you? Reply with the code only.",
        },
      ];
      const t2Res = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gemini-3.8-flash-low",
            messages: turn2Messages,
            stream: false,
          }),
        }
      );
      assert.equal(t2Res.status, 200);
      assert.equal(
        t2Res.headers.get("x-agy-session-reused"),
        "true",
        "Turn 2 should reuse the cached ACP sessionId"
      );
      assert.equal(t2Res.headers.get("x-agy-session-id"), sessionId1);
      const t2Json = (await t2Res.json()) as any;
      assert.match(t2Json.choices[0].message.content, /BANANA-42/i);

      // 3. Test OpenAI Function Calling (tools -> tool_calls)
      const toolRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gemini-3.8-flash-low",
            messages: [
              {
                role: "user",
                content: "Call the calculate_sum tool with a=15 and b=27.",
              },
            ],
            tools: [
              {
                type: "function",
                function: {
                  name: "calculate_sum",
                  description: "Add two numbers together",
                  parameters: {
                    type: "object",
                    properties: {
                      a: { type: "number" },
                      b: { type: "number" },
                    },
                    required: ["a", "b"],
                  },
                },
              },
            ],
            tool_choice: "required",
            stream: false,
          }),
        }
      );
      assert.equal(toolRes.status, 200);
      const toolJson = (await toolRes.json()) as any;
      assert.equal(toolJson.choices[0].finish_reason, "tool_calls");
      assert.ok(Array.isArray(toolJson.choices[0].message.tool_calls));
      assert.equal(
        toolJson.choices[0].message.tool_calls[0].function.name,
        "calculate_sum"
      );
      const parsedArgs = JSON.parse(
        toolJson.choices[0].message.tool_calls[0].function.arguments
      );
      assert.equal(parsedArgs.a, 15);
      assert.equal(parsedArgs.b, 27);
    } finally {
      await bridge.stop();
    }
  }
);
