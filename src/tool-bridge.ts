import * as crypto from "node:crypto";
import {
  AcpSessionUpdate,
  OpenAIChatCompletionRequest,
  OpenAIToolCall,
  OpenAIToolCallDelta,
  OpenAIToolDefinition,
} from "./types.js";

const OPEN_TAG = "<agy_tool_call>";
const CLOSE_TAG = "</agy_tool_call>";

export function buildSystemPromptAppend(
  req: OpenAIChatCompletionRequest,
  clientSystemMessages: string[],
  isAgentMode: boolean
): string {
  const parts: string[] = [];

  if (!isAgentMode) {
    parts.push(
      [
        "CRITICAL RUNTIME OVERRIDE:",
        "You are operating as a pure language model backend behind an OpenAI-compatible API bridge.",
        "Do NOT invoke any built-in Antigravity workspace tools (such as read_file, write_file, edit_file, run_command, search_web, invoke_subagent, ask_question, etc.).",
        "Never attempt to inspect or modify the local filesystem directly using your internal tools.",
      ].join("\n")
    );
  }

  if (clientSystemMessages.length > 0) {
    parts.push(
      "CLIENT SYSTEM INSTRUCTIONS:\n" + clientSystemMessages.join("\n\n")
    );
  }

  const hasClientTools =
    !isAgentMode &&
    Array.isArray(req.tools) &&
    req.tools.length > 0 &&
    req.tool_choice !== "none";

  if (hasClientTools) {
    parts.push(buildClientToolInstructions(req.tools!, req.tool_choice));
  }

  return parts.join("\n\n---\n\n");
}

function buildClientToolInstructions(
  tools: OpenAIToolDefinition[],
  toolChoice: OpenAIChatCompletionRequest["tool_choice"]
): string {
  const toolSpecs = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters ?? { type: "object", properties: {} },
  }));

  let choiceRule =
    "When you need to call one or more of these client tools, output each call inside an <agy_tool_call> XML block containing valid JSON with \"name\" and \"arguments\" keys, then STOP your response immediately and wait for the client to provide the tool result.";

  if (toolChoice === "required") {
    choiceRule =
      "You MUST call at least one of the provided client tools in this turn using an <agy_tool_call> block.";
  } else if (
    typeof toolChoice === "object" &&
    toolChoice !== null &&
    toolChoice.type === "function"
  ) {
    choiceRule = `You MUST call the client tool "${toolChoice.function.name}" in this turn using an <agy_tool_call> block.`;
  }

  return [
    "CLIENT-PROVIDED OPENAI TOOLS:",
    "You have access to the following external tools executed by the API client (do NOT confuse these with your disabled built-in tools):",
    JSON.stringify(toolSpecs),
    "",
    choiceRule,
    "",
    "Exact format for calling a client tool:",
    `${OPEN_TAG}`,
    '{"name": "tool_name", "arguments": {"param1": "value1"}}',
    `${CLOSE_TAG}`,
    "",
    "Rules for <agy_tool_call>:",
    "1. Only use tool names listed in CLIENT-PROVIDED OPENAI TOOLS above.",
    "2. The content inside <agy_tool_call>...</agy_tool_call> MUST be a single valid JSON object with \"name\" (string) and \"arguments\" (object).",
    "3. As soon as you close </agy_tool_call>, end your turn immediately without fabricating tool outputs.",
  ].join("\n");
}

export interface ParsedStreamStep {
  textDelta: string;
  toolCalls: OpenAIToolCall[];
  toolCallDeltas: OpenAIToolCallDelta[];
}

/**
 * Streaming parser that extracts `<agy_tool_call>{"name":...,"arguments":...}</agy_tool_call>`
 * while streaming normal text immediately and progressively emitting tool call argument deltas.
 */
export class ToolStreamParser {
  private buffer = "";
  private inTag = false;
  private enabled: boolean;
  private currentToolIndex = 0;
  private currentToolId = "";
  private currentToolName = "";
  private streamingArgs = false;
  private alreadyStreamedArgs = "";
  private tagBuffer = "";

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public push(chunk: string): ParsedStreamStep {
    if (!this.enabled) {
      return { textDelta: chunk, toolCalls: [], toolCallDeltas: [] };
    }

    this.buffer += chunk;
    let textDelta = "";
    const toolCalls: OpenAIToolCall[] = [];
    const toolCallDeltas: OpenAIToolCallDelta[] = [];

    while (this.buffer.length > 0) {
      if (!this.inTag) {
        const openIdx = this.buffer.indexOf(OPEN_TAG);
        if (openIdx !== -1) {
          textDelta += this.buffer.slice(0, openIdx);
          this.buffer = this.buffer.slice(openIdx + OPEN_TAG.length);
          this.inTag = true;
          this.tagBuffer = "";
          this.streamingArgs = false;
          this.currentToolId = "";
          this.currentToolName = "";
          this.alreadyStreamedArgs = "";
          continue;
        }

        // Check if the end of buffer could be a partial prefix of OPEN_TAG
        const partialLen = this.findPartialSuffixLength(this.buffer, OPEN_TAG);
        if (partialLen > 0) {
          const safeLen = this.buffer.length - partialLen;
          if (safeLen > 0) {
            textDelta += this.buffer.slice(0, safeLen);
            this.buffer = this.buffer.slice(safeLen);
          }
          break;
        } else {
          textDelta += this.buffer;
          this.buffer = "";
          break;
        }
      } else {
        const closeIdx = this.buffer.indexOf(CLOSE_TAG);
        if (closeIdx !== -1) {
          const chunkInsideTag = this.buffer.slice(0, closeIdx);
          this.tagBuffer += chunkInsideTag;
          this.buffer = this.buffer.slice(closeIdx + CLOSE_TAG.length);
          this.inTag = false;

          const parsed = this.tryParseToolCall(this.tagBuffer);
          if (parsed) {
            if (this.currentToolId) {
              parsed.id = this.currentToolId;
            } else {
              this.currentToolId = parsed.id;
            }

            if (!this.streamingArgs) {
              toolCallDeltas.push({
                index: this.currentToolIndex,
                id: parsed.id,
                type: "function",
                function: {
                  name: parsed.function.name,
                  arguments: parsed.function.arguments,
                },
              });
            } else {
              const finalArgs = parsed.function.arguments;
              const remaining = finalArgs.slice(this.alreadyStreamedArgs.length);
              if (remaining.length > 0) {
                toolCallDeltas.push({
                  index: this.currentToolIndex,
                  function: {
                    arguments: remaining,
                  },
                });
              }
            }

            toolCalls.push(parsed);
            this.currentToolIndex++;
          } else {
            // If malformed JSON, emit raw text back so nothing is lost
            textDelta += `${OPEN_TAG}${this.tagBuffer}${CLOSE_TAG}`;
          }

          this.tagBuffer = "";
          this.streamingArgs = false;
          this.currentToolId = "";
          this.currentToolName = "";
          this.alreadyStreamedArgs = "";
          continue;
        }

        // CLOSE_TAG not found yet. Check partial suffix of CLOSE_TAG.
        const partialCloseLen = this.findPartialSuffixLength(
          this.buffer,
          CLOSE_TAG
        );
        const safeEnd = this.buffer.length - partialCloseLen;
        if (safeEnd <= 0) {
          break;
        }

        const safeNewText = this.buffer.slice(0, safeEnd);
        this.tagBuffer += safeNewText;
        this.buffer = this.buffer.slice(safeEnd);

        if (!this.streamingArgs) {
          const nameMatch = /"name"\s*:\s*"([^"]+)"/.exec(this.tagBuffer);
          const argsMatch = /"arguments"\s*:\s*/.exec(this.tagBuffer);

          if (nameMatch && argsMatch) {
            this.currentToolName = nameMatch[1];
            this.currentToolId = `call_${crypto.randomBytes(12).toString("hex")}`;
            this.streamingArgs = true;

            toolCallDeltas.push({
              index: this.currentToolIndex,
              id: this.currentToolId,
              type: "function",
              function: {
                name: this.currentToolName,
                arguments: "",
              },
            });

            const argStartIndex = argsMatch.index + argsMatch[0].length;
            const rawArgsSoFar = this.tagBuffer.slice(argStartIndex);
            if (rawArgsSoFar.length > 4) {
              const emitLen = rawArgsSoFar.length - 4;
              const toEmit = rawArgsSoFar.slice(0, emitLen);
              toolCallDeltas.push({
                index: this.currentToolIndex,
                function: {
                  arguments: toEmit,
                },
              });
              this.alreadyStreamedArgs += toEmit;
            }
          }
        } else {
          const argsMatch = /"arguments"\s*:\s*/.exec(this.tagBuffer);
          if (argsMatch) {
            const argStartIndex = argsMatch.index + argsMatch[0].length;
            const totalArgsSoFar = this.tagBuffer.slice(argStartIndex);
            const unstreamed = totalArgsSoFar.slice(
              this.alreadyStreamedArgs.length
            );
            if (unstreamed.length > 4) {
              const toEmit = unstreamed.slice(0, unstreamed.length - 4);
              toolCallDeltas.push({
                index: this.currentToolIndex,
                function: {
                  arguments: toEmit,
                },
              });
              this.alreadyStreamedArgs += toEmit;
            }
          }
        }
        break;
      }
    }

    return { textDelta, toolCalls, toolCallDeltas };
  }

  public flush(): ParsedStreamStep {
    if (!this.enabled) {
      return { textDelta: "", toolCalls: [], toolCallDeltas: [] };
    }
    const leftover = this.tagBuffer + this.buffer;
    this.buffer = "";
    this.tagBuffer = "";

    if (this.inTag) {
      this.inTag = false;
      const parsed = this.tryParseToolCall(leftover.trim());
      if (parsed) {
        if (this.currentToolId) {
          parsed.id = this.currentToolId;
        }
        const toolCallDeltas: OpenAIToolCallDelta[] = [];
        if (!this.streamingArgs) {
          toolCallDeltas.push({
            index: this.currentToolIndex,
            id: parsed.id,
            type: "function",
            function: {
              name: parsed.function.name,
              arguments: parsed.function.arguments,
            },
          });
        } else {
          const finalArgs = parsed.function.arguments;
          const remaining = finalArgs.slice(this.alreadyStreamedArgs.length);
          if (remaining.length > 0) {
            toolCallDeltas.push({
              index: this.currentToolIndex,
              function: {
                arguments: remaining,
              },
            });
          }
        }
        this.currentToolIndex++;
        return { textDelta: "", toolCalls: [parsed], toolCallDeltas };
      }
      return {
        textDelta: `${OPEN_TAG}${leftover}`,
        toolCalls: [],
        toolCallDeltas: [],
      };
    }
    return { textDelta: leftover, toolCalls: [], toolCallDeltas: [] };
  }

  private findPartialSuffixLength(text: string, tag: string): number {
    const maxCheck = Math.min(text.length, tag.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      if (text.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  private tryParseToolCall(raw: string): OpenAIToolCall | null {
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      const obj = JSON.parse(cleaned);
      if (obj && typeof obj.name === "string") {
        const argsMatch = /"arguments"\s*:\s*/.exec(cleaned);
        let argsString = "";
        if (argsMatch) {
          const start = argsMatch.index + argsMatch[0].length;
          const lastBrace = cleaned.lastIndexOf("}");
          if (lastBrace > start) {
            argsString = cleaned.slice(start, lastBrace).trim();
          }
        }
        if (!argsString) {
          argsString =
            typeof obj.arguments === "string"
              ? obj.arguments
              : JSON.stringify(obj.arguments ?? {});
        }
        return {
          id: `call_${crypto.randomBytes(12).toString("hex")}`,
          type: "function",
          function: {
            name: obj.name,
            arguments: argsString,
          },
        };
      }
    } catch {
      // ignore parse failure
    }
    return null;
  }
}

export function formatAgentInternalToolUpdate(
  update: AcpSessionUpdate
): string | null {
  if (update.sessionUpdate === "tool_call") {
    const title = update.title || update.name || "tool";
    return `\n[agy tool: ${update.name ?? "exec"}] ${title} ...\n`;
  }
  if (update.sessionUpdate === "tool_call_update") {
    if (update.status === "completed") {
      const exitCode = update.rawOutput?.exit_code;
      const suffix = exitCode !== undefined ? ` (exit ${exitCode})` : " (done)";
      return `[agy tool: ${update.name ?? "exec"} completed${suffix}]\n`;
    }
    if (update.status === "failed" || update.status === "error") {
      return `[agy tool: ${update.name ?? "exec"} failed]\n`;
    }
  }
  return null;
}
