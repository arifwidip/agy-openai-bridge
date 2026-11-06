import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import {
  AcpModelInfo,
  AcpPromptContentBlock,
  AcpPromptResult,
  AcpSessionUpdate,
} from "./types.js";

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

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

export class AcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private sessionListeners = new Map<string, SessionUpdateListener>();
  private sessionAgentMode = new Map<string, boolean>();
  private initializedPromise: Promise<void> | null = null;
  private cachedModels: AcpModelInfo[] = [];

  constructor(
    private readonly agyBin: string = "agy",
    private readonly includeDefaultCustomizations: boolean = false,
    private readonly defaultCwd: string = process.cwd(),
    private readonly verbose: boolean = false
  ) {}

  private log(...args: unknown[]) {
    if (this.verbose) {
      console.error("[acp-client]", ...args);
    }
  }

  public async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed && this.initializedPromise) {
      return this.initializedPromise;
    }
    this.initializedPromise = this.startProcess();
    return this.initializedPromise;
  }

  private async startProcess(): Promise<void> {
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
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        this.handleIncomingMessage(msg);
      } catch (err) {
        this.log("Failed to parse JSON-RPC line:", trimmed, err);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
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

  private handleIncomingMessage(msg: any) {
    // 1. Server-to-client notification (e.g. session/update)
    if (msg.method && msg.id === undefined) {
      if (msg.method === "session/update" && msg.params?.sessionId) {
        const listener = this.sessionListeners.get(msg.params.sessionId);
        if (listener && msg.params.update) {
          listener(msg.params.update as AcpSessionUpdate);
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
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new Error(
            `ACP RPC Error (${msg.error.code}): ${msg.error.message}`
          )
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private handleServerRequest(msg: any) {
    if (!this.proc || this.proc.killed) return;

    if (msg.method === "session/request_permission") {
      const sessionId: string | undefined = msg.params?.sessionId;
      const isAgent = sessionId ? (this.sessionAgentMode.get(sessionId) ?? false) : false;
      const options: Array<{ optionId: string; kind?: string }> =
        msg.params?.options ?? [];

      let chosenOptionId: string | undefined;
      if (isAgent) {
        const allowOpt = options.find(
          (o) =>
            o.kind === "allow_once" ||
            o.kind === "allow_always" ||
            o.optionId.includes("allow")
        );
        chosenOptionId = allowOpt?.optionId ?? options[0]?.optionId;
      } else {
        const rejectOpt = options.find(
          (o) =>
            o.kind === "reject_once" ||
            o.kind === "reject_always" ||
            o.optionId.includes("reject") ||
            o.optionId.includes("deny")
        );
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

  private sendRequest(method: string, params: Record<string, unknown>): Promise<any> {
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
      this.proc!.stdin.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  public async newSession(
    opts: AcpNewSessionOptions,
    isAgentMode: boolean
  ): Promise<AcpNewSessionResult> {
    await this.ensureStarted();
    const params: Record<string, unknown> = {
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
    const sessionId: string = res.sessionId;
    this.sessionAgentMode.set(sessionId, isAgentMode);

    const availableModels: AcpModelInfo[] = res.models?.availableModels ?? [];
    if (availableModels.length > 0) {
      this.cachedModels = availableModels;
    }

    return {
      sessionId,
      availableModels,
      currentModelId: res.models?.currentModelId ?? "",
    };
  }

  public async getAvailableModels(): Promise<AcpModelInfo[]> {
    if (this.cachedModels.length > 0) {
      return this.cachedModels;
    }
    const temp = await this.newSession({ cwd: this.defaultCwd }, false);
    await this.closeSession(temp.sessionId).catch(() => {});
    return this.cachedModels;
  }

  public async getFastestLowModel(): Promise<string> {
    const models = await this.getAvailableModels();
    const priority = [
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-4-argon-low",
    ];
    for (const p of priority) {
      if (models.some((m) => m.modelId === p)) {
        return p;
      }
    }
    const anyLow = models.find((m) => m.modelId.endsWith("-low"));
    if (anyLow) return anyLow.modelId;
    const anyFlash = models.find((m) => m.modelId.includes("flash"));
    if (anyFlash) return anyFlash.modelId;
    return models[0]?.modelId ?? "gemini-3.8-flash-low";
  }

  public async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureStarted();
    await this.sendRequest("session/set_model", {
      sessionId,
      modelId,
    });
  }

  public async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.ensureStarted();
    await this.sendRequest("session/set_mode", {
      sessionId,
      modeId,
    });
  }

  public async prompt(
    sessionId: string,
    promptBlocks: AcpPromptContentBlock[],
    onUpdate: SessionUpdateListener
  ): Promise<AcpPromptResult> {
    await this.ensureStarted();
    this.sessionListeners.set(sessionId, onUpdate);
    try {
      const result = await this.sendRequest("session/prompt", {
        sessionId,
        prompt: promptBlocks,
      });
      return result as AcpPromptResult;
    } finally {
      this.sessionListeners.delete(sessionId);
    }
  }

  public async cancelSession(sessionId: string): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    try {
      await this.sendRequest("session/cancel", { sessionId });
    } catch {
      // Ignore cancel errors if turn already completed
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    this.sessionListeners.delete(sessionId);
    this.sessionAgentMode.delete(sessionId);
    if (!this.proc || this.proc.killed) return;
    try {
      await this.sendRequest("session/close", { sessionId });
    } catch {
      // Ignore close errors
    }
  }

  public shutdown(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}
