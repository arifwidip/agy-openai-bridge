import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { AcpClient } from "./acp-client.js";
import { SessionManager } from "./session-manager.js";
import {
  buildSystemPromptAppend,
  formatAgentInternalToolUpdate,
  ToolStreamParser,
} from "./tool-bridge.js";
import {
  AcpSessionUpdate,
  BridgeConfig,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIToolCall,
} from "./types.js";

const DEFAULT_FALLBACK_MODEL = "gemini-4-argon-high";

export class BridgeServer {
  private acp: AcpClient;
  private sessions: SessionManager;
  private server: http.Server;

  constructor(private readonly config: BridgeConfig) {
    this.acp = new AcpClient(
      config.agyBin,
      config.includeDefaultCustomizations,
      config.defaultCwd,
      config.verbose
    );
    this.sessions = new SessionManager(this.acp, config.maxCachedSessions);
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error("[bridge-server] Unhandled error:", err);
        if (!res.headersSent) {
          this.sendJson(res, 500, {
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: "server_error",
              code: "internal_error",
            },
          });
        }
      });
    });
  }

  public async start(): Promise<void> {
    await this.acp.ensureStarted();
    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    this.acp.shutdown();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Enable CORS for browser-based OpenAI clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Workspace-Dir"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const authCheck = this.checkAuthAndExtractCwd(req);
    if (!authCheck.authorized) {
      this.sendJson(res, 401, {
        error: {
          message: "Invalid API key",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      this.sendJson(res, 200, {
        status: "ok",
        defaultCwd: this.config.defaultCwd,
      });
      return;
    }

    if (
      req.method === "GET" &&
      (pathname === "/v1/models" || pathname === "/models")
    ) {
      await this.handleListModels(res);
      return;
    }

    if (
      req.method === "POST" &&
      (pathname === "/v1/chat/completions" || pathname === "/chat/completions")
    ) {
      const bodyStr = await this.readBody(req);
      let payload: OpenAIChatCompletionRequest;
      try {
        payload = JSON.parse(bodyStr);
      } catch {
        this.sendJson(res, 400, {
          error: {
            message: "Invalid JSON request body",
            type: "invalid_request_error",
            code: "invalid_json",
          },
        });
        return;
      }
      await this.handleChatCompletions(req, res, payload, authCheck.cwd);
      return;
    }

    this.sendJson(res, 404, {
      error: {
        message: `Unknown endpoint: ${req.method} ${pathname}`,
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  }

  private async handleListModels(res: http.ServerResponse): Promise<void> {
    const models = await this.acp.getAvailableModels();
    const created = Math.floor(Date.now() / 1000);
    const data: Array<Record<string, unknown>> = [];

    for (const m of models) {
      data.push({
        id: m.modelId,
        object: "model",
        created,
        owned_by: "antigravity",
        description: `${m.name} (Standard LLM / Client-Tools Mode)`,
      });
      data.push({
        id: `${m.modelId}-agent`,
        object: "model",
        created,
        owned_by: "antigravity-agent",
        description: `${m.name} (Full Antigravity Agent Mode with Workspace/MCP Tools)`,
      });
    }

    this.sendJson(res, 200, {
      object: "list",
      data,
    });
  }

  private async handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: OpenAIChatCompletionRequest,
    resolvedCwd: string
  ): Promise<void> {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      this.sendJson(res, 400, {
        error: {
          message: "'messages' must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    const { baseModelId, isAgentMode, responseModelId } =
      await this.resolveModel(body.model);

    const systemMessages: string[] = [];
    const nonSystemMessages: OpenAIChatMessage[] = [];
    for (const msg of body.messages) {
      if (msg.role === "system" || msg.role === "developer") {
        if (typeof msg.content === "string" && msg.content.trim()) {
          systemMessages.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          const joined = msg.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .filter(Boolean)
            .join("\n");
          if (joined.trim()) systemMessages.push(joined);
        }
      } else {
        nonSystemMessages.push(msg);
      }
    }

    const hasClientTools =
      !isAgentMode &&
      Array.isArray(body.tools) &&
      body.tools.length > 0 &&
      body.tool_choice !== "none";

    const systemPromptAppend = buildSystemPromptAppend(
      body,
      systemMessages,
      isAgentMode
    );

    const acquired = await this.sessions.acquireSession({
      baseModelId,
      isAgentMode,
      cwd: resolvedCwd,
      systemPromptAppend,
      nonSystemMessages,
    });

    const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const toolParser = new ToolStreamParser(hasClientTools);

    if (body.stream) {
      await this.streamChatCompletion(
        req,
        res,
        body,
        acquired,
        completionId,
        created,
        responseModelId,
        isAgentMode,
        toolParser
      );
    } else {
      await this.nonStreamChatCompletion(
        req,
        res,
        acquired,
        completionId,
        created,
        responseModelId,
        isAgentMode,
        toolParser
      );
    }
  }

  private async streamChatCompletion(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: OpenAIChatCompletionRequest,
    acquired: Awaited<ReturnType<SessionManager["acquireSession"]>>,
    completionId: string,
    created: number,
    responseModelId: string,
    isAgentMode: boolean,
    toolParser: ToolStreamParser
  ): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Agy-Session-Id": acquired.sessionId,
      "X-Agy-Session-Reused": acquired.reused ? "true" : "false",
    });

    let clientAborted = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientAborted = true;
        this.acp.cancelSession(acquired.sessionId).catch(() => {});
      }
    });

    const writeChunk = (
      delta: Record<string, unknown>,
      finishReason: string | null = null,
      usage?: Record<string, unknown>
    ) => {
      if (clientAborted || res.writableEnded) return;
      const chunkObj: Record<string, unknown> = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: responseModelId,
        choices: [
          {
            index: 0,
            delta,
            finish_reason: finishReason,
          },
        ],
      };
      if (usage) {
        chunkObj.usage = usage;
      }
      res.write(`data: ${JSON.stringify(chunkObj)}\n\n`);
    };

    // Send initial role chunk
    writeChunk({ role: "assistant", content: "" });

    let fullAssistantText = "";
    const allToolCalls: OpenAIToolCall[] = [];
    let nextToolIndex = 0;

    const emitParsedStep = (step: {
      textDelta: string;
      toolCalls: OpenAIToolCall[];
    }) => {
      if (step.textDelta) {
        fullAssistantText += step.textDelta;
        writeChunk({ content: step.textDelta });
      }
      for (const tc of step.toolCalls) {
        allToolCalls.push(tc);
        const idx = nextToolIndex++;
        writeChunk({
          tool_calls: [
            {
              index: idx,
              id: tc.id,
              type: "function",
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            },
          ],
        });
      }
    };

    try {
      const promptResult = await this.acp.prompt(
        acquired.sessionId,
        acquired.promptBlocks,
        (update: AcpSessionUpdate) => {
          if (clientAborted) return;

          if (update.sessionUpdate === "agent_thought_chunk") {
            const thoughtText = this.extractUpdateText(update);
            if (thoughtText) {
              writeChunk({ reasoning_content: thoughtText });
            }
            return;
          }

          if (
            isAgentMode &&
            (update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update")
          ) {
            const formatted = formatAgentInternalToolUpdate(update);
            if (formatted) {
              writeChunk({ reasoning_content: formatted });
            }
            return;
          }

          if (update.sessionUpdate === "agent_message_chunk") {
            const textChunk = this.extractUpdateText(update);
            if (textChunk) {
              const step = toolParser.push(textChunk);
              emitParsedStep(step);
            }
          }
        }
      );

      const flushed = toolParser.flush();
      emitParsedStep(flushed);

      acquired.finalizeTurn(fullAssistantText, allToolCalls);

      const finishReason =
        allToolCalls.length > 0 ? "tool_calls" : "stop";

      const usagePayload = this.formatOpenAIUsage(promptResult.usage);
      if (body.stream_options?.include_usage && usagePayload) {
        writeChunk({}, finishReason);
        if (!clientAborted && !res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: responseModelId,
              choices: [],
              usage: usagePayload,
            })}\n\n`
          );
        }
      } else {
        writeChunk({}, finishReason, usagePayload);
      }

      if (!clientAborted && !res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch (err) {
      await acquired.releaseOnError();
      if (!clientAborted && !res.writableEnded) {
        writeChunk(
          {
            content: `\n[Bridge Error: ${
              err instanceof Error ? err.message : String(err)
            }]`,
          },
          "stop"
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  }

  private async nonStreamChatCompletion(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    acquired: Awaited<ReturnType<SessionManager["acquireSession"]>>,
    completionId: string,
    created: number,
    responseModelId: string,
    isAgentMode: boolean,
    toolParser: ToolStreamParser
  ): Promise<void> {
    let fullAssistantText = "";
    let fullReasoningText = "";
    const allToolCalls: OpenAIToolCall[] = [];

    res.on("close", () => {
      if (!res.writableEnded) {
        this.acp.cancelSession(acquired.sessionId).catch(() => {});
      }
    });

    try {
      const promptResult = await this.acp.prompt(
        acquired.sessionId,
        acquired.promptBlocks,
        (update: AcpSessionUpdate) => {
          if (update.sessionUpdate === "agent_thought_chunk") {
            fullReasoningText += this.extractUpdateText(update);
            return;
          }
          if (
            isAgentMode &&
            (update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update")
          ) {
            const formatted = formatAgentInternalToolUpdate(update);
            if (formatted) {
              fullReasoningText += formatted;
            }
            return;
          }
          if (update.sessionUpdate === "agent_message_chunk") {
            const textChunk = this.extractUpdateText(update);
            if (textChunk) {
              const step = toolParser.push(textChunk);
              fullAssistantText += step.textDelta;
              allToolCalls.push(...step.toolCalls);
            }
          }
        }
      );

      const flushed = toolParser.flush();
      fullAssistantText += flushed.textDelta;
      allToolCalls.push(...flushed.toolCalls);

      acquired.finalizeTurn(fullAssistantText, allToolCalls);

      const messageObj: Record<string, unknown> = {
        role: "assistant",
        content:
          allToolCalls.length > 0 && !fullAssistantText
            ? null
            : fullAssistantText,
      };
      if (fullReasoningText) {
        messageObj.reasoning_content = fullReasoningText;
      }
      if (allToolCalls.length > 0) {
        messageObj.tool_calls = allToolCalls;
      }

      const finishReason =
        allToolCalls.length > 0 ? "tool_calls" : "stop";

      res.setHeader("X-Agy-Session-Id", acquired.sessionId);
      res.setHeader(
        "X-Agy-Session-Reused",
        acquired.reused ? "true" : "false"
      );

      this.sendJson(res, 200, {
        id: completionId,
        object: "chat.completion",
        created,
        model: responseModelId,
        choices: [
          {
            index: 0,
            message: messageObj,
            finish_reason: finishReason,
          },
        ],
        usage: this.formatOpenAIUsage(promptResult.usage) ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    } catch (err) {
      await acquired.releaseOnError();
      this.sendJson(res, 500, {
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: "server_error",
          code: "acp_prompt_error",
        },
      });
    }
  }

  private extractUpdateText(update: AcpSessionUpdate): string {
    if (!update.content) return "";
    if (!Array.isArray(update.content)) {
      return update.content.text ?? "";
    }
    return update.content
      .map((item) => item.content?.text ?? "")
      .join("");
  }

  private formatOpenAIUsage(
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      thoughtTokens?: number;
      totalTokens?: number;
    }
  ): Record<string, unknown> | undefined {
    if (!usage) return undefined;
    const promptTokens = usage.inputTokens ?? 0;
    const completionTokens =
      (usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0);
    const totalTokens =
      usage.totalTokens ?? promptTokens + completionTokens;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      ...(usage.thoughtTokens !== undefined
        ? {
            completion_tokens_details: {
              reasoning_tokens: usage.thoughtTokens,
            },
          }
        : {}),
    };
  }

  private async resolveModel(requestedModel?: string): Promise<{
    baseModelId: string;
    isAgentMode: boolean;
    responseModelId: string;
  }> {
    const raw = (requestedModel || DEFAULT_FALLBACK_MODEL).trim();
    const isAgentMode = raw.endsWith("-agent");
    const stripped = isAgentMode ? raw.slice(0, -"-agent".length) : raw;

    const available = await this.acp.getAvailableModels();
    const exact = available.find((m) => m.modelId === stripped);
    if (exact) {
      return {
        baseModelId: exact.modelId,
        isAgentMode,
        responseModelId: raw,
      };
    }

    // Fuzzy/alias match (e.g. "claude-sonnet" or "gpt-4o")
    const lower = stripped.toLowerCase();
    const fuzzy = available.find((m) =>
      m.modelId.toLowerCase().includes(lower)
    );
    if (fuzzy) {
      return {
        baseModelId: fuzzy.modelId,
        isAgentMode,
        responseModelId: isAgentMode
          ? `${fuzzy.modelId}-agent`
          : fuzzy.modelId,
      };
    }

    const fallback = available[0]?.modelId ?? DEFAULT_FALLBACK_MODEL;
    return {
      baseModelId: fallback,
      isAgentMode,
      responseModelId: isAgentMode ? `${fallback}-agent` : fallback,
    };
  }

  private checkAuthAndExtractCwd(req: http.IncomingMessage): {
    authorized: boolean;
    cwd: string;
  } {
    let cwd = this.config.defaultCwd;

    // 1. Check X-Workspace-Dir header
    const headerCwd = req.headers["x-workspace-dir"];
    if (typeof headerCwd === "string" && headerCwd.trim()) {
      const candidate = headerCwd.trim();
      if (fs.existsSync(candidate)) {
        cwd = candidate;
      }
    }

    // 2. Check Authorization Bearer token (supports `cwd=/path` or `key;cwd=/path`)
    const authHeader = req.headers["authorization"] ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

    let providedKey = bearer;
    if (bearer.includes("cwd=")) {
      const parts = bearer.split(/[;,]/);
      const nonCwdParts: string[] = [];
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith("cwd=")) {
          const candidate = trimmed.slice("cwd=".length).trim();
          if (candidate && fs.existsSync(candidate)) {
            cwd = candidate;
          }
        } else if (trimmed) {
          nonCwdParts.push(trimmed);
        }
      }
      providedKey = nonCwdParts.join(";");
    }

    if (this.config.apiKey && providedKey !== this.config.apiKey) {
      return { authorized: false, cwd };
    }

    return { authorized: true, cwd };
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    data: unknown
  ): void {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}
