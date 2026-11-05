import * as crypto from "node:crypto";
import { AcpClient } from "./acp-client.js";
import {
  AcpPromptContentBlock,
  OpenAIChatMessage,
  OpenAIToolCall,
} from "./types.js";

interface CachedSession {
  sessionId: string;
  baseModelId: string;
  isAgentMode: boolean;
  cwd: string;
  systemHash: string;
  prefixHash: string;
  busy: boolean;
  lastUsedAt: number;
}

export interface AcquiredSession {
  sessionId: string;
  promptBlocks: AcpPromptContentBlock[];
  reused: boolean;
  finalizeTurn: (
    assistantText: string,
    assistantToolCalls: OpenAIToolCall[]
  ) => void;
  releaseOnError: () => Promise<void>;
}

export class SessionManager {
  private sessions = new Map<string, CachedSession>();

  constructor(
    private readonly acp: AcpClient,
    private readonly maxCachedSessions: number = 50
  ) {}

  public async acquireSession(opts: {
    baseModelId: string;
    isAgentMode: boolean;
    cwd: string;
    systemPromptAppend: string;
    nonSystemMessages: OpenAIChatMessage[];
  }): Promise<AcquiredSession> {
    const {
      baseModelId,
      isAgentMode,
      cwd,
      systemPromptAppend,
      nonSystemMessages,
    } = opts;

    const systemHash = this.hashObject({
      baseModelId,
      isAgentMode,
      cwd,
      systemPromptAppend,
    });

    // Find last assistant message index to split historyPrefix vs new delta messages
    let lastAssistantIdx = -1;
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      if (nonSystemMessages[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }

    const hasReusableSplit =
      lastAssistantIdx >= 0 && lastAssistantIdx < nonSystemMessages.length - 1;

    if (hasReusableSplit) {
      const historyPrefix = nonSystemMessages.slice(0, lastAssistantIdx + 1);
      const deltaMessages = nonSystemMessages.slice(lastAssistantIdx + 1);
      const candidatePrefixHash = this.hashMessages(systemHash, historyPrefix);

      for (const [, cached] of this.sessions) {
        if (
          !cached.busy &&
          cached.systemHash === systemHash &&
          cached.prefixHash === candidatePrefixHash
        ) {
          cached.busy = true;
          cached.lastUsedAt = Date.now();
          const promptBlocks = this.messagesToPromptBlocks(deltaMessages, true);

          return {
            sessionId: cached.sessionId,
            promptBlocks,
            reused: true,
            finalizeTurn: (assistantText, assistantToolCalls) => {
              const syntheticAssistant: OpenAIChatMessage = {
                role: "assistant",
                content: assistantText || null,
                ...(assistantToolCalls.length > 0
                  ? { tool_calls: assistantToolCalls }
                  : {}),
              };
              const nextHistory = [...nonSystemMessages, syntheticAssistant];
              cached.prefixHash = this.hashMessages(systemHash, nextHistory);
              cached.busy = false;
              cached.lastUsedAt = Date.now();
            },
            releaseOnError: async () => {
              this.sessions.delete(cached.sessionId);
              await this.acp.closeSession(cached.sessionId);
            },
          };
        }
      }
    }

    // Fallback: create a fresh ACP session and send full conversation history
    await this.evictIfNeeded();
    const created = await this.acp.newSession(
      {
        cwd,
        systemPromptAppend: systemPromptAppend || undefined,
      },
      isAgentMode
    );

    if (baseModelId && created.currentModelId !== baseModelId) {
      await this.acp.setModel(created.sessionId, baseModelId);
    }

    const cached: CachedSession = {
      sessionId: created.sessionId,
      baseModelId,
      isAgentMode,
      cwd,
      systemHash,
      prefixHash: "",
      busy: true,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(created.sessionId, cached);

    const promptBlocks = this.messagesToPromptBlocks(nonSystemMessages, false);

    return {
      sessionId: created.sessionId,
      promptBlocks,
      reused: false,
      finalizeTurn: (assistantText, assistantToolCalls) => {
        const syntheticAssistant: OpenAIChatMessage = {
          role: "assistant",
          content: assistantText || null,
          ...(assistantToolCalls.length > 0
            ? { tool_calls: assistantToolCalls }
            : {}),
        };
        const nextHistory = [...nonSystemMessages, syntheticAssistant];
        cached.prefixHash = this.hashMessages(systemHash, nextHistory);
        cached.busy = false;
        cached.lastUsedAt = Date.now();
      },
      releaseOnError: async () => {
        this.sessions.delete(created.sessionId);
        await this.acp.closeSession(created.sessionId);
      },
    };
  }

  private messagesToPromptBlocks(
    messages: OpenAIChatMessage[],
    isDeltaTurn: boolean
  ): AcpPromptContentBlock[] {
    // If there is only a single user message, send its blocks directly without transcript framing
    if (messages.length === 1 && messages[0].role === "user") {
      return this.extractContentBlocks(messages[0]);
    }

    const blocks: AcpPromptContentBlock[] = [];
    const transcriptLines: string[] = [];

    if (!isDeltaTurn && messages.length > 1) {
      transcriptLines.push(
        "CONVERSATION HISTORY (continue naturally from the final message below):"
      );
    }

    for (const msg of messages) {
      if (msg.role === "user") {
        const msgBlocks = this.extractContentBlocks(msg);
        const texts = msgBlocks
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text!);
        if (texts.length > 0) {
          transcriptLines.push(`[User]:\n${texts.join("\n")}`);
        }
        for (const b of msgBlocks) {
          if (b.type === "image") {
            blocks.push(b);
          }
        }
      } else if (msg.role === "assistant") {
        const text = this.extractTextOnly(msg);
        const toolCallsStr =
          msg.tool_calls && msg.tool_calls.length > 0
            ? msg.tool_calls
                .map(
                  (tc) =>
                    `<agy_tool_call>\n${JSON.stringify({
                      name: tc.function.name,
                      arguments: this.safeParseJson(tc.function.arguments),
                    })}\n</agy_tool_call>`
                )
                .join("\n")
            : "";
        const combined = [text, toolCallsStr].filter(Boolean).join("\n");
        transcriptLines.push(`[Assistant]:\n${combined}`);
      } else if (msg.role === "tool") {
        const text = this.extractTextOnly(msg);
        const idLabel = msg.tool_call_id ? ` (id=${msg.tool_call_id})` : "";
        const nameLabel = msg.name ? ` (tool=${msg.name})` : "";
        transcriptLines.push(
          `[Tool Result${nameLabel}${idLabel}]:\n${text}`
        );
      }
    }

    blocks.unshift({
      type: "text",
      text: transcriptLines.join("\n\n"),
    });

    return blocks;
  }

  private extractContentBlocks(msg: OpenAIChatMessage): AcpPromptContentBlock[] {
    if (typeof msg.content === "string") {
      return [{ type: "text", text: msg.content }];
    }
    if (Array.isArray(msg.content)) {
      const result: AcpPromptContentBlock[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          result.push({ type: "text", text: part.text });
        } else if (part.type === "image_url" && part.image_url?.url) {
          const parsedImg = this.parseDataUrl(part.image_url.url);
          if (parsedImg) {
            result.push({
              type: "image",
              data: parsedImg.base64,
              mimeType: parsedImg.mimeType,
            });
          } else {
            result.push({
              type: "text",
              text: `[Image URL: ${part.image_url.url}]`,
            });
          }
        }
      }
      return result.length > 0 ? result : [{ type: "text", text: "" }];
    }
    return [{ type: "text", text: "" }];
  }

  private extractTextOnly(msg: OpenAIChatMessage): string {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  private parseDataUrl(
    url: string
  ): { mimeType: string; base64: string } | null {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (!match) return null;
    return { mimeType: match[1], base64: match[2] };
  }

  private safeParseJson(str: string): unknown {
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  }

  private hashMessages(
    systemHash: string,
    messages: OpenAIChatMessage[]
  ): string {
    const normalized = messages.map((m) => ({
      role: m.role,
      content: this.extractTextOnly(m),
      tool_call_id: m.tool_call_id ?? null,
      tool_calls:
        m.tool_calls?.map((tc) => ({
          name: tc.function.name,
          arguments: tc.function.arguments,
        })) ?? null,
    }));
    return this.hashObject({ systemHash, normalized });
  }

  private hashObject(obj: unknown): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(obj))
      .digest("hex");
  }

  private async evictIfNeeded(): Promise<void> {
    if (this.sessions.size < this.maxCachedSessions) return;
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, s] of this.sessions) {
      if (!s.busy && s.lastUsedAt < oldestTime) {
        oldestTime = s.lastUsedAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.sessions.delete(oldestId);
      await this.acp.closeSession(oldestId);
    }
  }
}
