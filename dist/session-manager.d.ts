import { AcpClient } from "./acp-client.js";
import { AcpPromptContentBlock, OpenAIChatMessage, OpenAIToolCall } from "./types.js";
export interface AcquiredSession {
    sessionId: string;
    promptBlocks: AcpPromptContentBlock[];
    reused: boolean;
    finalizeTurn: (assistantText: string, assistantToolCalls: OpenAIToolCall[]) => void;
    releaseOnError: () => Promise<void>;
}
export declare class SessionManager {
    private readonly acp;
    private readonly maxCachedSessions;
    private sessions;
    constructor(acp: AcpClient, maxCachedSessions?: number);
    acquireSession(opts: {
        baseModelId: string;
        isAgentMode: boolean;
        cwd: string;
        systemPromptAppend: string;
        nonSystemMessages: OpenAIChatMessage[];
    }): Promise<AcquiredSession>;
    private messagesToPromptBlocks;
    private extractContentBlocks;
    private extractTextOnly;
    private parseDataUrl;
    private safeParseJson;
    private hashMessages;
    private hashObject;
    private evictIfNeeded;
}
