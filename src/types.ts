export interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAIToolDefinition {
  type: "function";
  function: OpenAIToolFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export type OpenAIMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface OpenAIChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OpenAIMessageContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  tools?: OpenAIToolDefinition[];
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  user?: string;
}

export interface AcpModelInfo {
  modelId: string;
  name: string;
}

export interface AcpPromptContentBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface AcpSessionUpdate {
  sessionUpdate:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "user_message_chunk"
    | "tool_call"
    | "tool_call_update"
    | "session_info_update"
    | "available_commands_update"
    | string;
  content?:
    | { type: string; text?: string }
    | Array<{ type: string; content?: { type: string; text?: string } }>;
  toolCallId?: string;
  name?: string;
  title?: string;
  status?: string;
  kind?: string;
  args?: Record<string, unknown>;
  rawInput?: Record<string, unknown>;
  rawOutput?: { output?: string; exit_code?: number };
}

export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface AcpPromptResult {
  stopReason: string;
  usage?: AcpUsage;
}

export interface BridgeConfig {
  port: number;
  host: string;
  defaultCwd: string;
  apiKey?: string;
  agyBin: string;
  includeDefaultCustomizations: boolean;
  maxCachedSessions: number;
  verbose: boolean;
}
