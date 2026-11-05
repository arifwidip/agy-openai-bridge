import { BridgeConfig } from "./types.js";
export declare class BridgeServer {
    private readonly config;
    private acp;
    private sessions;
    private server;
    constructor(config: BridgeConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    private handleRequest;
    private handleListModels;
    private handleChatCompletions;
    private streamChatCompletion;
    private nonStreamChatCompletion;
    private extractUpdateText;
    private formatOpenAIUsage;
    private resolveModel;
    private checkAuthAndExtractCwd;
    private readBody;
    private sendJson;
}
