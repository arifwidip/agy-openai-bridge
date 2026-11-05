import { AcpModelInfo, AcpPromptContentBlock, AcpPromptResult, AcpSessionUpdate } from "./types.js";
export type SessionUpdateListener = (update: AcpSessionUpdate) => void;
export interface AcpNewSessionOptions {
    cwd: string;
    systemPromptAppend?: string;
}
export interface AcpNewSessionResult {
    sessionId: string;
    availableModels: AcpModelInfo[];
    currentModelId: string;
}
export declare class AcpClient {
    private readonly agyBin;
    private readonly includeDefaultCustomizations;
    private readonly defaultCwd;
    private readonly verbose;
    private proc;
    private nextId;
    private pending;
    private sessionListeners;
    private sessionAgentMode;
    private initializedPromise;
    private cachedModels;
    constructor(agyBin?: string, includeDefaultCustomizations?: boolean, defaultCwd?: string, verbose?: boolean);
    private log;
    ensureStarted(): Promise<void>;
    private startProcess;
    private handleIncomingMessage;
    private handleServerRequest;
    private sendRequest;
    newSession(opts: AcpNewSessionOptions, isAgentMode: boolean): Promise<AcpNewSessionResult>;
    getAvailableModels(): Promise<AcpModelInfo[]>;
    setModel(sessionId: string, modelId: string): Promise<void>;
    setMode(sessionId: string, modeId: string): Promise<void>;
    prompt(sessionId: string, promptBlocks: AcpPromptContentBlock[], onUpdate: SessionUpdateListener): Promise<AcpPromptResult>;
    cancelSession(sessionId: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    shutdown(): void;
}
