import { spawn } from "node:child_process";
import * as readline from "node:readline";
export class AcpClient {
    agyBin;
    includeDefaultCustomizations;
    defaultCwd;
    verbose;
    proc = null;
    nextId = 1;
    pending = new Map();
    sessionListeners = new Map();
    sessionAgentMode = new Map();
    initializedPromise = null;
    cachedModels = [];
    constructor(agyBin = "agy", includeDefaultCustomizations = false, defaultCwd = process.cwd(), verbose = false) {
        this.agyBin = agyBin;
        this.includeDefaultCustomizations = includeDefaultCustomizations;
        this.defaultCwd = defaultCwd;
        this.verbose = verbose;
    }
    log(...args) {
        if (this.verbose) {
            console.error("[acp-client]", ...args);
        }
    }
    async ensureStarted() {
        if (this.proc && !this.proc.killed && this.initializedPromise) {
            return this.initializedPromise;
        }
        this.initializedPromise = this.startProcess();
        return this.initializedPromise;
    }
    async startProcess() {
        const args = [
            "acp",
            "--dangerously-skip-permissions",
            `--include-default-customizations=${this.includeDefaultCustomizations ? "true" : "false"}`,
        ];
        this.log(`Spawning: ${this.agyBin} ${args.join(" ")}`);
        const proc = spawn(this.agyBin, args, {
            cwd: this.defaultCwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
        });
        this.proc = proc;
        const rl = readline.createInterface({
            input: proc.stdout,
            crlfDelay: Infinity,
        });
        rl.on("line", (line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return;
            try {
                const msg = JSON.parse(trimmed);
                this.handleIncomingMessage(msg);
            }
            catch (err) {
                this.log("Failed to parse JSON-RPC line:", trimmed, err);
            }
        });
        proc.stderr.on("data", (chunk) => {
            if (this.verbose) {
                process.stderr.write(`[agy-acp stderr] ${chunk.toString()}`);
            }
        });
        proc.on("exit", (code, signal) => {
            this.log(`agy acp exited (code=${code}, signal=${signal})`);
            this.proc = null;
            this.initializedPromise = null;
            const err = new Error(`agy acp process exited (code=${code}, signal=${signal})`);
            for (const [, p] of this.pending) {
                p.reject(err);
            }
            this.pending.clear();
        });
        await this.sendRequest("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: {
                name: "agy-openai-bridge",
                version: "0.1.0",
            },
        });
    }
    handleIncomingMessage(msg) {
        // 1. Server-to-client notification (e.g. session/update)
        if (msg.method && msg.id === undefined) {
            if (msg.method === "session/update" && msg.params?.sessionId) {
                const listener = this.sessionListeners.get(msg.params.sessionId);
                if (listener && msg.params.update) {
                    listener(msg.params.update);
                }
            }
            return;
        }
        // 2. Server-to-client RPC request (e.g. session/request_permission)
        if (msg.method && msg.id !== undefined) {
            this.handleServerRequest(msg);
            return;
        }
        // 3. Response to client-to-server RPC request
        if (msg.id !== undefined) {
            const pending = this.pending.get(msg.id);
            if (!pending)
                return;
            this.pending.delete(msg.id);
            if (msg.error) {
                pending.reject(new Error(`ACP RPC Error (${msg.error.code}): ${msg.error.message}`));
            }
            else {
                pending.resolve(msg.result);
            }
        }
    }
    handleServerRequest(msg) {
        if (!this.proc || this.proc.killed)
            return;
        if (msg.method === "session/request_permission") {
            const sessionId = msg.params?.sessionId;
            const isAgent = sessionId ? (this.sessionAgentMode.get(sessionId) ?? false) : false;
            const options = msg.params?.options ?? [];
            let chosenOptionId;
            if (isAgent) {
                const allowOpt = options.find((o) => o.kind === "allow_once" ||
                    o.kind === "allow_always" ||
                    o.optionId.includes("allow"));
                chosenOptionId = allowOpt?.optionId ?? options[0]?.optionId;
            }
            else {
                const rejectOpt = options.find((o) => o.kind === "reject_once" ||
                    o.kind === "reject_always" ||
                    o.optionId.includes("reject") ||
                    o.optionId.includes("deny"));
                chosenOptionId = rejectOpt?.optionId;
            }
            const response = chosenOptionId
                ? {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        outcome: {
                            outcome: "selected",
                            optionId: chosenOptionId,
                        },
                    },
                }
                : {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        outcome: {
                            outcome: "cancelled",
                        },
                    },
                };
            this.proc.stdin.write(JSON.stringify(response) + "\n");
            return;
        }
        // Default fallback for unhandled server RPCs
        const errResp = {
            jsonrpc: "2.0",
            id: msg.id,
            error: {
                code: -32601,
                message: `Method not supported by bridge: ${msg.method}`,
            },
        };
        this.proc.stdin.write(JSON.stringify(errResp) + "\n");
    }
    sendRequest(method, params) {
        if (!this.proc || this.proc.killed) {
            return Promise.reject(new Error("ACP process is not running"));
        }
        const id = this.nextId++;
        const payload = {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.proc.stdin.write(JSON.stringify(payload) + "\n", (err) => {
                if (err) {
                    this.pending.delete(id);
                    reject(err);
                }
            });
        });
    }
    async newSession(opts, isAgentMode) {
        await this.ensureStarted();
        const params = {
            cwd: opts.cwd,
            mcpServers: [],
        };
        if (opts.systemPromptAppend) {
            params._meta = {
                antigravity: {
                    systemPrompt: {
                        append: opts.systemPromptAppend,
                    },
                },
            };
        }
        const res = await this.sendRequest("session/new", params);
        const sessionId = res.sessionId;
        this.sessionAgentMode.set(sessionId, isAgentMode);
        const availableModels = res.models?.availableModels ?? [];
        if (availableModels.length > 0) {
            this.cachedModels = availableModels;
        }
        return {
            sessionId,
            availableModels,
            currentModelId: res.models?.currentModelId ?? "",
        };
    }
    async getAvailableModels() {
        if (this.cachedModels.length > 0) {
            return this.cachedModels;
        }
        const temp = await this.newSession({ cwd: this.defaultCwd }, false);
        await this.closeSession(temp.sessionId).catch(() => { });
        return this.cachedModels;
    }
    async setModel(sessionId, modelId) {
        await this.ensureStarted();
        await this.sendRequest("session/set_model", {
            sessionId,
            modelId,
        });
    }
    async setMode(sessionId, modeId) {
        await this.ensureStarted();
        await this.sendRequest("session/set_mode", {
            sessionId,
            modeId,
        });
    }
    async prompt(sessionId, promptBlocks, onUpdate) {
        await this.ensureStarted();
        this.sessionListeners.set(sessionId, onUpdate);
        try {
            const result = await this.sendRequest("session/prompt", {
                sessionId,
                prompt: promptBlocks,
            });
            return result;
        }
        finally {
            this.sessionListeners.delete(sessionId);
        }
    }
    async cancelSession(sessionId) {
        if (!this.proc || this.proc.killed)
            return;
        try {
            await this.sendRequest("session/cancel", { sessionId });
        }
        catch {
            // Ignore cancel errors if turn already completed
        }
    }
    async closeSession(sessionId) {
        this.sessionListeners.delete(sessionId);
        this.sessionAgentMode.delete(sessionId);
        if (!this.proc || this.proc.killed)
            return;
        try {
            await this.sendRequest("session/close", { sessionId });
        }
        catch {
            // Ignore close errors
        }
    }
    shutdown() {
        if (this.proc && !this.proc.killed) {
            this.proc.kill("SIGTERM");
            this.proc = null;
        }
    }
}
