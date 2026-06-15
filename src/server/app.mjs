import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createReviewStore } from "./store/review-store.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const webDir = join(root, "src", "web");
const designV1Path = join(root, "design-v1-markdown-review.html");
const interactionV1Path = join(root, "interaction-v1-markdown-review.html");

export function createWithAiServer(options = {}) {
  const store = createReviewStore({ root: options.root || process.cwd() });

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, name: "withai" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/runtime") {
        sendJson(response, 200, readRuntime(options.root || process.cwd()));
        return;
      }

      if (request.method === "GET" && url.pathname === "/design-v1") {
        sendFile(response, designV1Path, "text/html; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/interaction-v1") {
        sendFile(response, interactionV1Path, "text/html; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/reviews") {
        sendJson(response, 200, store.listReviews());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reviews") {
        const payload = await readJsonBody(request);
        const created = store.createReview(payload);
        sendJson(response, 201, store.getPublicReview(created.review.id, created.review.ownerToken));
        return;
      }

      const reviewApi = url.pathname.match(/^\/api\/reviews\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
      if (reviewApi) {
        const [, reviewId, resource, child] = reviewApi;
        const secret = readSecret(request, url);

        if (request.method === "GET" && !resource) {
          sendJson(response, 200, store.getPublicReview(reviewId, secret));
          return;
        }

        if (request.method === "GET" && resource === "history") {
          store.authorizeReview(reviewId, secret);
          sendJson(response, 200, store.buildHistory(reviewId, url.searchParams.get("from"), url.searchParams.get("to")));
          return;
        }

        if (request.method === "POST" && resource === "comments") {
          const authorized = store.authorizeReview(reviewId, secret);
          if (!authorized.viewer.canComment) {
            sendJson(response, 403, { error: "You cannot comment on this review." });
            return;
          }
          const payload = await readJsonBody(request);
          sendJson(response, 201, store.addComment(reviewId, payload));
          return;
        }

        if (request.method === "PATCH" && resource === "comments" && child) {
          const authorized = store.authorizeReview(reviewId, secret);
          if (!authorized.viewer.canResolve) {
            sendJson(response, 403, { error: "Only the owner can modify comments." });
            return;
          }
          const payload = await readJsonBody(request);
          if (payload.action === "edit") {
            sendJson(response, 200, store.editComment(reviewId, child, payload));
          } else {
            sendJson(response, 200, store.resolveComment(reviewId, child, payload));
          }
          return;
        }

        if (request.method === "POST" && resource === "revisions") {
          const authorized = store.authorizeReview(reviewId, secret);
          if (!authorized.viewer.canPublish) {
            sendJson(response, 403, { error: "Only the owner can publish a new revision." });
            return;
          }
          const payload = await readJsonBody(request);
          const published = store.publishRevision(reviewId, payload);
          const statusCode = published.unchanged ? 200 : 201;
          sendJson(response, statusCode, store.getPublicReview(reviewId, secret));
          return;
        }

        if (request.method === "POST" && resource === "agent-sessions") {
          const authorized = store.authorizeReview(reviewId, secret);
          if (!authorized.viewer.canCreateAgentSession) {
            sendJson(response, 403, { error: "This viewer cannot create agent sessions." });
            return;
          }
          const payload = await readJsonBody(request);
          sendJson(response, 201, store.createAgentSession(reviewId, payload));
          return;
        }

        if (request.method === "POST" && resource === "push-wecom") {
          const authorized = store.authorizeReview(reviewId, secret);
          if (!authorized.viewer.canPublish) {
            sendJson(response, 403, { error: "Only the owner can push to WeCom." });
            return;
          }
          try {
            const result = pushToWecom(store, reviewId);
            sendJson(response, 200, result);
          } catch (error) {
            sendJson(response, error.statusCode || 500, { error: error.message });
          }
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/agent/comments") {
        const payload = await readJsonBody(request);
        sendJson(response, 201, store.addAgentComment(payload));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/agent/resolve") {
        const payload = await readJsonBody(request);
        const context = store.getAgentContext(payload.token);
        const result = store.resolveComment(context.review.id, payload.commentId, { actor: payload.author || "owner-agent" });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/agent/context") {
        sendJson(response, 200, store.getAgentContext(url.searchParams.get("token") || readSecret(request, url)));
        return;
      }

      if (request.method === "GET" && /^\/r\/[^/]+\/[^/]+$/.test(url.pathname)) {
        sendFile(response, join(webDir, "index.html"), "text/html; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        sendFile(response, join(webDir, "index.html"), "text/html; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
        const assetPath = join(webDir, url.pathname.replace(/^\/assets\//, ""));
        if (!assetPath.startsWith(webDir) || !existsSync(assetPath)) {
          sendJson(response, 404, { error: "Not found" });
          return;
        }
        sendFile(response, assetPath, contentType(assetPath));
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: error.message });
    }
  });
}

function readRuntime(projectRoot) {
  const runtimePath = join(projectRoot, ".withai", "runtime.json");
  if (!existsSync(runtimePath)) {
    return {
      localOrigin: "",
      publicOrigin: "",
      hasPublicTunnel: false,
      running: true,
    };
  }
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  return {
    localOrigin: runtime.localOrigin || "",
    publicOrigin: runtime.publicOrigin || runtime.localOrigin || "",
    hasPublicTunnel: Boolean(runtime.publicOrigin && runtime.localOrigin && runtime.publicOrigin !== runtime.localOrigin),
    mode: runtime.mode || "start",
    startedAt: runtime.startedAt || "",
    running: true,
  };
}

function readSecret(request, url) {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || url.searchParams.get("secret") || "";
}

function pushToWecom(store, reviewId) {
  // Check wecom-cli is available and authorized
  try {
    const status = execSync("wecom-cli auth show --auth-status", { encoding: "utf8", timeout: 5000 }).trim();
    if (status !== "authorized") {
      throw Object.assign(new Error("wecom-cli 未授权。请先运行: wecom-cli init --noninteractive"), { statusCode: 400 });
    }
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error("wecom-cli 未安装。请先运行: npm install -g @wecom/cli@0.1.8"), { statusCode: 400 });
  }

  const review = store.getReview(reviewId);
  const payload = store.getPublicReview(reviewId, review.ownerToken);
  const markdown = payload.document.markdown;
  const title = review.title;

  let docid = review.wecomDocId;
  let url = review.wecomDocUrl;

  // Create doc if first time
  if (!docid) {
    const createArgs = JSON.stringify({ doc_type: 3, doc_name: title });
    const createResult = execSync(`wecom-cli doc create_doc ${shellEscape(createArgs)}`, { encoding: "utf8", timeout: 15000 });
    const createData = parseWecomResult(createResult);
    if (createData.errcode !== 0) {
      throw Object.assign(new Error(`企微创建文档失败: ${createData.errmsg}`), { statusCode: 502 });
    }
    docid = createData.docid;
    url = createData.url;
  }

  // Write content
  const editArgs = JSON.stringify({ docid, content: markdown, content_type: 1 });
  const editResult = execSync(`wecom-cli doc edit_doc_content ${shellEscape(editArgs)}`, { encoding: "utf8", timeout: 15000 });
  const editData = parseWecomResult(editResult);
  if (editData.errcode !== 0) {
    throw Object.assign(new Error(`企微写入文档失败: ${editData.errmsg}`), { statusCode: 502 });
  }

  // Save docid to review
  store.setWecomDoc(reviewId, docid, url);
  return { ok: true, url, docid };
}

function parseWecomResult(raw) {
  try {
    const wrapper = JSON.parse(raw);
    const text = wrapper?.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : {};
  } catch {
    return { errcode: -1, errmsg: "Failed to parse wecom-cli response" };
  }
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendFile(response, path, type) {
  response.writeHead(200, { "Content-Type": type });
  response.end(readFileSync(path));
}

function contentType(path) {
  const ext = extname(path);
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

export async function listenWithFallback(server, startPort = 4173, endPort = 4183) {
  for (let port = startPort; port <= endPort; port += 1) {
    try {
      await listen(server, port);
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || port === endPort) throw error;
    }
  }
  throw new Error("Could not bind local server.");
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createWithAiServer();
  listenWithFallback(server).then((port) => {
    console.log(`WithAI running at http://127.0.0.1:${port}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
