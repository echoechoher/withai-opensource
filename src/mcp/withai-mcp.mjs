#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReviewStore } from "../server/store/review-store.mjs";

const root = resolve(process.env.WITHAI_ROOT || process.cwd());
const store = createReviewStore({ root });
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages().catch((error) => {
    send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error.message } });
  });
});

async function drainMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const raw = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);
    await handle(JSON.parse(raw));
  }
}

async function handle(message) {
  if (!message.id && message.method?.startsWith("notifications/")) return;

  if (message.method === "initialize") {
    sendResult(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        resources: {},
        tools: {},
      },
      serverInfo: {
        name: "withai-mcp",
        version: "0.1.0",
      },
    });
    return;
  }

  if (message.method === "resources/list") {
    sendResult(message.id, { resources: listResources() });
    return;
  }

  if (message.method === "resources/read") {
    const uri = message.params?.uri;
    sendResult(message.id, { contents: [readResource(uri)] });
    return;
  }

  if (message.method === "tools/list") {
    sendResult(message.id, {
      tools: [
        {
          name: "withai_write_comment",
          description: "Write a structured comment into a WithAI review using an agent token.",
          inputSchema: {
            type: "object",
            required: ["token", "body", "anchor"],
            properties: {
              token: { type: "string" },
              author: { type: "string" },
              body: { type: "string" },
              anchor: {
                type: "object",
                required: ["quote"],
                properties: {
                  quote: { type: "string", description: "The exact text from the document you are commenting on" },
                },
              },
            },
          },
        },
      ],
    });
    return;
  }

  if (message.method === "tools/call") {
    if (message.params?.name !== "withai_write_comment") {
      sendError(message.id, -32602, "Unknown tool");
      return;
    }
    try {
      const comment = store.addAgentComment(message.params.arguments || {});
      sendResult(message.id, {
        content: [{ type: "text", text: JSON.stringify(comment, null, 2) }],
      });
    } catch (error) {
      sendError(message.id, error.statusCode === 403 ? -32003 : -32602, error.message);
    }
    return;
  }

  sendError(message.id, -32601, `Unsupported method: ${message.method}`);
}

function listResources() {
  return store.listReviews().flatMap((review) => [
    {
      uri: `withai://reviews/${review.id}/context.md`,
      name: `${review.title} review context`,
      mimeType: "text/markdown",
    },
    {
      uri: `withai://reviews/${review.id}/context.json`,
      name: `${review.title} review context JSON`,
      mimeType: "application/json",
    },
  ]);
}

function readResource(uri) {
  const match = String(uri || "").match(/^withai:\/\/reviews\/([^/]+)\/(context\.(?:md|json))$/);
  if (!match) throw new Error("Unknown WithAI resource URI.");
  const [, reviewId, file] = match;
  const path = join(root, ".withai", "reviews", reviewId, file);
  if (!existsSync(path)) throw new Error("WithAI resource does not exist.");
  return {
    uri,
    mimeType: file.endsWith(".json") ? "application/json" : "text/markdown",
    text: readFileSync(path, "utf8"),
  };
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
