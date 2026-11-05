import test from "node:test";
import assert from "node:assert/strict";
import { BridgeServer } from "./server.js";
import { ToolStreamParser } from "./tool-bridge.js";
test("ToolStreamParser extracts <agy_tool_call> across chunk boundaries", () => {
    const parser = new ToolStreamParser(true);
    const s1 = parser.push("Let me check the weather. <agy_tool");
    assert.equal(s1.textDelta, "Let me check the weather. ");
    assert.equal(s1.toolCalls.length, 0);
    const s2 = parser.push('_call>\n{"name": "get_weather", "arguments": {"city": "Jakarta"}}\n</agy_tool_');
    assert.equal(s2.textDelta, "");
    assert.equal(s2.toolCalls.length, 0);
    const s3 = parser.push("call>");
    assert.equal(s3.textDelta, "");
    assert.equal(s3.toolCalls.length, 1);
    assert.equal(s3.toolCalls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(s3.toolCalls[0].function.arguments), {
        city: "Jakarta",
    });
});
test("End-to-end BridgeServer: /v1/models, multi-turn session reuse, streaming, and OpenAI tool_calls", async () => {
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
        const modelsJson = (await modelsRes.json());
        assert.equal(modelsJson.object, "list");
        assert.ok(modelsJson.data.length >= 2);
        const hasStandard = modelsJson.data.some((m) => !m.id.endsWith("-agent"));
        const hasAgent = modelsJson.data.some((m) => m.id.endsWith("-agent"));
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
        const t1Res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "gemini-3.8-flash-low",
                messages: turn1Messages,
                stream: false,
            }),
        });
        assert.equal(t1Res.status, 200);
        assert.equal(t1Res.headers.get("x-agy-session-reused"), "false");
        const sessionId1 = t1Res.headers.get("x-agy-session-id");
        assert.ok(sessionId1);
        const t1Json = (await t1Res.json());
        const assistantReply1 = t1Json.choices[0].message.content;
        assert.ok(assistantReply1);
        // Turn 2: append assistant reply + new user question
        const turn2Messages = [
            ...turn1Messages,
            { role: "assistant", content: assistantReply1 },
            {
                role: "user",
                content: "What was the secret code I told you? Reply with the code only.",
            },
        ];
        const t2Res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "gemini-3.8-flash-low",
                messages: turn2Messages,
                stream: false,
            }),
        });
        assert.equal(t2Res.status, 200);
        assert.equal(t2Res.headers.get("x-agy-session-reused"), "true", "Turn 2 should reuse the cached ACP sessionId");
        assert.equal(t2Res.headers.get("x-agy-session-id"), sessionId1);
        const t2Json = (await t2Res.json());
        assert.match(t2Json.choices[0].message.content, /BANANA-42/i);
        // 3. Test OpenAI Function Calling (tools -> tool_calls)
        const toolRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
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
        });
        assert.equal(toolRes.status, 200);
        const toolJson = (await toolRes.json());
        assert.equal(toolJson.choices[0].finish_reason, "tool_calls");
        assert.ok(Array.isArray(toolJson.choices[0].message.tool_calls));
        assert.equal(toolJson.choices[0].message.tool_calls[0].function.name, "calculate_sum");
        const parsedArgs = JSON.parse(toolJson.choices[0].message.tool_calls[0].function.arguments);
        assert.equal(parsedArgs.a, 15);
        assert.equal(parsedArgs.b, 27);
    }
    finally {
        await bridge.stop();
    }
});
