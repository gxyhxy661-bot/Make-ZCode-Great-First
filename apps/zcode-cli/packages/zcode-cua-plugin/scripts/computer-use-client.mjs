#!/usr/bin/env node
/**
 * computer-use-client.mjs — 零依赖的 Computer Use MCP 客户端（排障/自测用）。
 *
 * 直接以 stdio 子进程方式拉起同插件打包好的 dist/mcp/server.js，完成 MCP initialize
 * 握手后，把 stdin 的 JSON-RPC 请求透传给 server、把响应回显到 stdout。
 *
 * 用法：
 *   node scripts/computer-use-client.mjs list                  # 枚举工具
 *   node scripts/computer-use-client.mjs call <tool> '<json>'  # 调用工具，如：
 *   node scripts/computer-use-client.mjs call list_apps '{}'
 *   node scripts/computer-use-client.mjs pipe < requests.jsonl # 逐行透传请求
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "mcp", "server.js");

let nextId = 1;
const pending = new Map();

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      if (message.error) resolver.reject(new Error(JSON.stringify(message.error)));
      else resolver.resolve(message.result);
    } else {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    }
  });
  child.on("exit", (code) => {
    for (const resolver of pending.values()) {
      resolver.reject(new Error(`computer-use server exited with ${code}`));
    }
    pending.clear();
  });
  return child;
}

function rpc(child, method, params) {
  const id = nextId++;
  const message = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function withSession(handler) {
  const child = startServer();
  try {
    await rpc(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "computer-use-client", version: "0.1.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await handler(child);
  } finally {
    child.kill();
  }
}

const [command, toolName, toolArgs] = process.argv.slice(2);

if (command === "list") {
  await withSession(async (child) => {
    const result = await rpc(child, "tools/list", {});
    for (const tool of result.tools ?? []) {
      process.stdout.write(`${tool.name}\t${tool.description ?? ""}\n`);
    }
  });
} else if (command === "call" && toolName) {
  await withSession(async (child) => {
    let args = {};
    if (toolArgs) {
      try {
        args = JSON.parse(toolArgs);
      } catch {
        console.error("工具参数必须是合法 JSON");
        process.exit(2);
      }
    }
    const result = await rpc(child, "tools/call", { name: toolName, arguments: args });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
} else if (command === "pipe") {
  await withSession(async (child) => {
    const stdin = createInterface({ input: process.stdin });
    const queue = [];
    stdin.on("line", (line) => {
      if (line.trim()) queue.push(line);
    });
    // 简单串行泵：stdin 结束后按行透传。
    await new Promise((resolve) => stdin.once("close", resolve));
    for (const line of queue) {
      const response = await new Promise((resolve) => {
        const raw = JSON.parse(line);
        const resolver = (message) => {
          pending.delete(raw.id);
          resolve(message);
        };
        pending.set(raw.id, { resolve: resolver, reject: resolver });
        child.stdin.write(`${line}\n`);
      });
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
} else {
  process.stdout.write(
    [
      "用法:",
      "  node scripts/computer-use-client.mjs list",
      "  node scripts/computer-use-client.mjs call <tool> '<json-args>'",
      "  node scripts/computer-use-client.mjs pipe < requests.jsonl",
      "",
    ].join("\n"),
  );
  process.exit(command ? 2 : 0);
}
