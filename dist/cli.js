#!/usr/bin/env node
import { BridgeServer } from "./server.js";
function parseArgs(argv) {
    const config = {
        port: Number(process.env.PORT || 8787),
        host: process.env.HOST || "127.0.0.1",
        defaultCwd: process.env.AGY_CWD || process.cwd(),
        apiKey: process.env.API_KEY || undefined,
        agyBin: process.env.AGY_BIN || "agy",
        includeDefaultCustomizations: process.env.AGY_INCLUDE_CUSTOMIZATIONS === "true",
        maxCachedSessions: Number(process.env.MAX_SESSIONS || 50),
        verbose: process.env.VERBOSE === "true",
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }
        else if (arg === "--port" || arg === "-p") {
            config.port = Number(argv[++i]);
        }
        else if (arg === "--host") {
            config.host = argv[++i];
        }
        else if (arg === "--cwd") {
            config.defaultCwd = argv[++i];
        }
        else if (arg === "--api-key") {
            config.apiKey = argv[++i];
        }
        else if (arg === "--agy-bin") {
            config.agyBin = argv[++i];
        }
        else if (arg === "--include-customizations") {
            config.includeDefaultCustomizations = true;
        }
        else if (arg === "--verbose" || arg === "-v") {
            config.verbose = true;
        }
    }
    return config;
}
function printHelp() {
    console.log(`
agy-openai-bridge — OpenAI-compatible API server powered by "agy acp"

Usage:
  agy-openai-bridge [options]

Options:
  -p, --port <number>          Port to listen on (default: 8787 or $PORT)
  --host <address>             Host to bind (default: 127.0.0.1 or $HOST)
  --cwd <path>                 Default workspace directory for -agent mode (default: cwd)
  --api-key <key>              Optional Bearer API key required from clients ($API_KEY)
  --agy-bin <path>             Path to agy binary (default: agy)
  --include-customizations     Load default agy skills/MCPs in ACP sessions (default: false)
  -v, --verbose                Enable verbose ACP JSON-RPC logging
  -h, --help                   Show this help message

Endpoints:
  GET  /v1/models              Lists standard models (<model>) and agentic models (<model>-agent)
  POST /v1/chat/completions    OpenAI-compatible chat completions (streaming & non-streaming)
  GET  /health                 Health check

Per-Request Workspace Override (for -agent models):
  Header:   X-Workspace-Dir: /path/to/repo
  API Key:  Authorization: Bearer cwd=/path/to/repo
`);
}
async function main() {
    const config = parseArgs(process.argv.slice(2));
    const server = new BridgeServer(config);
    const shutdown = async () => {
        console.log("\nShutting down agy-openai-bridge...");
        await server.stop();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log("Starting agy acp backend...");
    await server.start();
    console.log(`
🚀 agy-openai-bridge is running!
   Base URL:       http://${config.host}:${config.port}/v1
   Models URL:     http://${config.host}:${config.port}/v1/models
   Chat URL:       http://${config.host}:${config.port}/v1/chat/completions
   Default CWD:    ${config.defaultCwd}
   Mode Selection: Use "<model>" for pure LLM / client tools, or "<model>-agent" for full agy agent mode
`);
}
main().catch((err) => {
    console.error("Failed to start agy-openai-bridge:", err);
    process.exit(1);
});
