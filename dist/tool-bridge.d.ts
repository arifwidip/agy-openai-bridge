import { AcpSessionUpdate, OpenAIChatCompletionRequest, OpenAIToolCall } from "./types.js";
export declare function buildSystemPromptAppend(req: OpenAIChatCompletionRequest, clientSystemMessages: string[], isAgentMode: boolean): string;
export interface ParsedStreamStep {
    textDelta: string;
    toolCalls: OpenAIToolCall[];
}
/**
 * Streaming parser that extracts `<agy_tool_call>{"name":...,"arguments":...}</agy_tool_call>`
 * while streaming normal text immediately with zero buffering outside potential tag prefixes.
 */
export declare class ToolStreamParser {
    private buffer;
    private inTag;
    private enabled;
    constructor(enabled: boolean);
    push(chunk: string): ParsedStreamStep;
    flush(): ParsedStreamStep;
    private findPartialSuffixLength;
    private tryParseToolCall;
}
export declare function formatAgentInternalToolUpdate(update: AcpSessionUpdate): string | null;
