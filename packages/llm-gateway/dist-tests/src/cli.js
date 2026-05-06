#!/usr/bin/env node
import { Command } from "commander";
import { resolveConfig } from "./config.js";
import { startServer } from "./server.js";
const program = new Command();
program
    .name("stackbilt-llm-gateway")
    .description("Local-first LLM gateway for Claude Code, Codex, and future agent CLIs")
    .version("0.1.0");
program
    .command("start")
    .description("Start the local gateway server")
    .option("--port <port>", "Override port", (raw) => Number(raw))
    .action(async (options) => {
    const config = resolveConfig({ port: options.port });
    await startServer(config);
    // Keep this minimal because this command is intended to run as a long-lived local process.
    // eslint-disable-next-line no-console
    console.log(`StackBilt LLM Gateway listening on http://localhost:${config.port}`);
});
program.parseAsync(process.argv);
