import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { createReviewStore } from "../src/server/store/review-store.mjs";

const root = mkdtempSync(join(tmpdir(), "withai-mcp-"));
const mdPath = join(root, "doc.md");
writeFileSync(mdPath, "# Doc\n\nA paragraph for review.\n");
const store = createReviewStore({ root });
const payload = store.createReview({ sourcePath: mdPath });
const session = store.createAgentSession(payload.review.id, { author: "reviewer-agent" });

const child = spawn(process.execPath, ["src/mcp/withai-mcp.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, WITHAI_ROOT: root },
});

let buffer = Buffer.alloc(0);
const responses = [];

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1] || 0);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    responses.push(JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8")));
    buffer = buffer.slice(bodyEnd);
  }
});

send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send(child, { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} });
await waitFor(() => responses.length >= 2);

const resources = responses.find((response) => response.id === 2).result.resources;
const mdResource = resources.find((resource) => resource.uri.endsWith("/context.md"));
const jsonResource = resources.find((resource) => resource.uri.endsWith("/context.json"));
assert.ok(mdResource);
assert.ok(jsonResource);

send(child, { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: mdResource.uri } });
send(child, { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: jsonResource.uri } });
send(child, { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
await waitFor(() => responses.some((response) => response.id === 5));

send(child, {
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: {
    name: "withai_write_comment",
    arguments: {
      token: session.token,
      body: "Agent comment through MCP.",
      anchor: {
        quote: "A paragraph for review.",
      },
    },
  },
});
await waitFor(() => responses.some((response) => response.id === 6));
store.revokeAgent(payload.review.id, session.id);
send(child, {
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: {
    name: "withai_write_comment",
    arguments: {
      token: session.token,
      body: "Should fail.",
      anchor: {
        quote: "A paragraph for review.",
      },
    },
  },
});
await waitFor(() => responses.some((response) => response.id === 7));
child.kill();

assert.equal(responses.find((response) => response.id === 1).result.serverInfo.name, "withai-mcp");
assert.match(responses.find((response) => response.id === 3).result.contents[0].text, /WithAI Review Context/);
assert.equal(JSON.parse(responses.find((response) => response.id === 4).result.contents[0].text).review.ownerToken, undefined);
assert.ok(responses.find((response) => response.id === 5).result.tools.some((tool) => tool.name === "withai_write_comment"));
assert.match(responses.find((response) => response.id === 6).result.content[0].text, /Agent comment through MCP/);
assert.match(responses.find((response) => response.id === 7).error.message, /Invalid agent token/);
console.log("withai mcp product test passed");

function send(childProcess, message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  childProcess.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  childProcess.stdin.write(body);
}

async function waitFor(predicate) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 3000) throw new Error("Timed out waiting for MCP response");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
