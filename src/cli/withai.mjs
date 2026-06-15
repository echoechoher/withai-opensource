#!/usr/bin/env node
import { accessSync, constants, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, watch as watchFile } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createWithAiServer, listenWithFallback } from "../server/app.mjs";
import { createReviewStore } from "../server/store/review-store.mjs";

const args = process.argv.slice(2);
const command = args.shift();
const flags = parseFlags(args);
const installRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const invocationCwd = process.cwd();
const projectRoot = resolve(flags.root || process.env.WITHAI_ROOT || installRoot);
const store = createReviewStore({ root: projectRoot });
const LAUNCH_LABEL = "com.withai.server";

try {
  if (!command || command === "help") {
    printHelp();
  } else if (command === "serve") {
    await serve();
  } else if (command === "start") {
    await start();
  } else if (command === "create") {
    create();
  } else if (command === "share" || command === "review") {
    await share();
  } else if (command === "list") {
    list();
  } else if (command === "links") {
    links();
  } else if (command === "publish") {
    publish();
  } else if (command === "watch") {
    watchReview();
  } else if (command === "context") {
    context();
  } else if (command === "agent-comment") {
    agentComment();
  } else if (command === "bridge" || command === "connect") {
    await bridge();
  } else if (command === "doctor") {
    await doctor();
  } else if (command === "configure" || command === "config") {
    configure();
  } else if (command === "launch") {
    await launch();
  } else if (command === "rotate") {
    rotate();
  } else if (command === "revoke-agent") {
    revokeAgent();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function serve() {
  const server = createWithAiServer({ root: projectRoot });
  const port = await listenWithFallback(server, Number(flags.port || 4173), Number(flags.endPort || 4183));
  const localOrigin = `http://127.0.0.1:${port}`;
  writeRuntime({ localOrigin, publicOrigin: localOrigin, port, startedAt: new Date().toISOString(), mode: "serve" });
  console.log(`WithAI running at ${localOrigin}`);
}

async function start() {
  const config = readConfig();
  const port = Number(flags.port || process.env.WITHAI_PORT || config.port || 4174);
  const noTunnel = flags.noTunnel || config.noTunnel || false;
  const server = createWithAiServer({ root: projectRoot });
  const actualPort = await listenWithFallback(server, port, Number(flags.endPort || port + 10));
  const localOrigin = `http://127.0.0.1:${actualPort}`;
  console.log(`WithAI local server: ${localOrigin}`);

  let publicOrigin = localOrigin;
  let ngrokProcess = null;
  if (!noTunnel) {
    const publicUrl = flags.url || flags.publicUrl || process.env.WITHAI_PUBLIC_URL || config.publicUrl;
    const ngrokArgs = ["http", String(actualPort), "--log=stdout"];
    if (publicUrl) ngrokArgs.push("--url", publicUrl);
    ngrokProcess = spawn("ngrok", ngrokArgs, { stdio: ["ignore", "pipe", "pipe"] });
    ngrokProcess.stderr.on("data", (chunk) => process.stderr.write(chunk));
    try {
      publicOrigin = await waitForNgrokOrigin();
      console.log(`WithAI public tunnel: ${publicOrigin}`);
    } catch (error) {
      ngrokProcess.kill();
      throw new Error(`ngrok tunnel did not start: ${error.message}`);
    }
  }

  writeRuntime({ localOrigin, publicOrigin, port: actualPort, startedAt: new Date().toISOString() });
  printActiveReviews(publicOrigin);
  console.log("Press Ctrl+C to stop WithAI.");
  await new Promise((resolve) => {
    process.on("SIGINT", () => {
      ngrokProcess?.kill();
      server.close(resolve);
    });
  });
}

function create() {
  const sourcePath = resolveInputPath(argsRequired(1, "create <markdown-file>")[0]);
  const review = store.createReview({
    sourcePath,
    author: flags.author || "owner",
    title: flags.title,
  });
  const origin = flags.origin || "http://127.0.0.1:4173";
  console.log(`Created review: ${review.review.id}`);
  console.log(`Title: ${review.review.title}`);
  console.log(`Source: ${review.review.sourcePath}`);
  printReviewLinks(review.review, origin);
  console.log(`Agent context: ${review.contextPath}`);
}

async function share() {
  const sourcePath = resolveInputPath(argsRequired(1, `${command} <markdown-file>`)[0]);
  const runtime = readRuntime();
  const origin = flags.origin || runtime?.publicOrigin || runtime?.localOrigin || "http://127.0.0.1:4174";
  await warnIfOriginUnavailable(origin);

  // Check if this file already has a review (unless --new forces a fresh one)
  if (!flags.new) {
    const existing = findReviewBySource(sourcePath);
    if (existing) {
      const markdown = readFileSync(sourcePath, "utf8");
      const result = store.publishRevision(existing.id, { markdown, author: flags.author || "owner" });
      const review = store.getReview(existing.id);
      if (result.unchanged) {
        console.log(`Review exists: ${review.id} (${review.currentRevisionId}, no changes)`);
      } else {
        console.log(`Published ${review.currentRevisionId} to existing review: ${review.id}`);
      }
      printReviewLinks(review, origin);
      console.log(`Agent context: ${result.contextPath}`);
      return;
    }
  }

  const review = store.createReview({
    sourcePath,
    author: flags.author || "owner",
    title: flags.title,
  });
  console.log(`Created review: ${review.review.id}`);
  printReviewLinks(review.review, origin);
  console.log(`Agent context: ${review.contextPath}`);
}

function list() {
  const reviews = store.listReviews();
  if (!reviews.length) {
    console.log("No reviews yet.");
    return;
  }
  for (const review of reviews) {
    console.log(`${review.id}\t${review.currentRevisionId}\t${review.title}`);
  }
}

function links() {
  const [reviewId] = argsRequired(1, "links <review-id>");
  const review = store.getReview(reviewId);
  const runtime = readRuntime();
  const origin = flags.origin || runtime?.publicOrigin || runtime?.localOrigin || "http://127.0.0.1:4174";
  console.log(`Review: ${review.id}`);
  console.log(`Title: ${review.title}`);
  printReviewLinks(review, origin);
  console.log(`Local source: ${review.sourcePath || "none"}`);
}

function publish() {
  const [reviewId, maybePath] = argsRequired(1, "publish <review-id> [markdown-file]");
  const payload = {
    author: flags.author || "owner-agent",
  };
  if (maybePath) payload.markdown = readFileSync(resolveInputPath(maybePath), "utf8");
  const review = store.publishRevision(reviewId, payload);
  if (review.unchanged) {
    console.log(`No changes for ${review.review.id}; still on ${review.review.currentRevisionId}`);
  } else {
    console.log(`Published ${review.review.currentRevisionId} for ${review.review.id}`);
  }
  console.log(`Agent context: ${review.contextPath}`);
}

function watchReview() {
  const [reviewId] = argsRequired(1, "watch <review-id>");
  const review = store.getReview(reviewId);
  if (!review.sourcePath) throw new Error("Review has no local source path.");
  let timer = null;
  let lastMarkdown = readFileSync(review.sourcePath, "utf8");
  console.log(`Watching ${review.sourcePath}`);
  console.log(`Review: ${reviewId}`);
  const publishIfChanged = () => {
    const nextMarkdown = readFileSync(review.sourcePath, "utf8");
    if (nextMarkdown === lastMarkdown) return;
    lastMarkdown = nextMarkdown;
    const result = store.publishRevision(reviewId, { markdown: nextMarkdown, author: flags.author || "owner-agent" });
    if (!result.unchanged) console.log(`Published ${result.review.currentRevisionId} at ${new Date().toISOString()}`);
  };
  const watcher = watchFile(review.sourcePath, () => {
    clearTimeout(timer);
    timer = setTimeout(publishIfChanged, Number(flags.debounce || 1000));
  });
  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

function context() {
  const [reviewId] = argsRequired(1, "context <review-id>");
  const paths = store.writeAgentContext(reviewId);
  console.log(paths.md);
  if (flags.json) console.log(paths.json);
}

function agentComment() {
  const [reviewId] = argsRequired(1, "agent-comment <review-id> --token <token> --quote <quote> --body <body>");
  const payload = {
    token: requiredFlag("token"),
    author: flags.author,
    body: requiredFlag("body"),
    revisionId: flags.revision,
    anchor: {
      quote: flags.quote || requiredFlag("quote"),
    },
  };
  store.addAgentComment(payload);
  store.writeAgentContext(reviewId);
  console.log("Agent comment saved.");
}

async function bridge() {
  const server = String(flags.server || "http://127.0.0.1:4173").replace(/\/$/, "");
  const reviewId = requiredFlag("review");
  const token = requiredFlag("token");

  if (flags.resolve) {
    const payload = { token, commentId: flags.resolve, author: flags.author };
    const response = await fetch(`${server}/api/agent/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not resolve comment");
    console.log(`Resolved: ${result.id}`);
    return;
  }

  if (flags.body) {
    const payload = {
      token,
      author: flags.author,
      body: flags.body,
      anchor: {
        quote: flags.quote || requiredFlag("quote"),
      },
    };
    const response = await fetch(`${server}/api/agent/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not write agent comment");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const contextUrl = `${server}/api/agent/context?token=${encodeURIComponent(token)}&review=${encodeURIComponent(reviewId)}`;
  const response = await fetch(contextUrl);
  const context = await response.json();
  if (!response.ok) throw new Error(context.error || "Could not read agent context");
  console.log(JSON.stringify(context, null, 2));
}

async function doctor() {
  const checks = [];
  checks.push(["Node >= 20", Number(process.versions.node.split(".")[0]) >= 20]);
  checks.push(["ngrok installed", Boolean(await commandPath("ngrok"))]);
  ensureRuntimeDir();
  checks.push([".withai writable", isWritable(store.workspaceDir)]);
  checks.push(["MCP resources available", await mcpSmoke()]);
  const runtime = readRuntime();
  if (runtime?.localOrigin) {
    checks.push([`server reachable (${runtime.localOrigin})`, await httpOk(`${runtime.localOrigin}/health`)]);
  } else {
    checks.push(["server reachable", true, "not checked; run withai start first"]);
  }
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
  if (existsSync(plistPath)) {
    let pid = null;
    try {
      const output = execSync(`launchctl list ${LAUNCH_LABEL} 2>/dev/null`, { encoding: "utf8" });
      const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
      pid = pidMatch ? pidMatch[1] : null;
    } catch {}
    checks.push(["LaunchAgent installed", true, pid ? `PID ${pid}` : "loaded but no PID"]);
  } else {
    checks.push(["LaunchAgent installed", true, "not installed; run: withai launch"]);
  }
  for (const [label, ok, note] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${label}${note ? ` (${note})` : ""}`);
  }
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

function rotate() {
  const [reviewId] = argsRequired(1, "rotate <review-id> --owner|--reviewer");
  const kind = flags.owner ? "owner" : flags.reviewer ? "reviewer" : null;
  if (!kind) throw new Error("Use --owner or --reviewer.");
  const review = store.rotateToken(reviewId, kind);
  const origin = readRuntime()?.publicOrigin || readRuntime()?.localOrigin || "http://127.0.0.1:4174";
  console.log(`Rotated ${kind} token for ${review.id}`);
  if (kind === "owner") console.log(`Owner link: ${origin}/r/${review.id}/${review.ownerToken}`);
  if (kind === "reviewer") console.log(`Review link: ${origin}/r/${review.id}/${review.shareSecret}`);
}

function revokeAgent() {
  const [reviewId, sessionId] = argsRequired(2, "revoke-agent <review-id> <agent_session_id>");
  const session = store.revokeAgent(reviewId, sessionId);
  console.log(`Revoked agent session: ${session.id}`);
}

function configure() {
  const configPath = join(store.workspaceDir, "config.json");

  if (flags.reset) {
    if (existsSync(configPath)) unlinkSync(configPath);
    console.log("Config reset.");
    return;
  }

  const hasSettings = flags.port || flags.publicUrl || flags["public-url"] || flags.noTunnel || flags["no-tunnel"] || flags.tunnel;
  if (!hasSettings) {
    const config = readConfig();
    if (!Object.keys(config).length) {
      console.log("No config set yet. Example:");
      console.log("  withai configure --public-url https://xxx.ngrok.app --port 4174");
      return;
    }
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const config = readConfig();
  if (flags.port) config.port = Number(flags.port);
  if (flags.publicUrl || flags["public-url"]) config.publicUrl = flags.publicUrl || flags["public-url"];
  if (flags.noTunnel || flags["no-tunnel"]) config.noTunnel = true;
  if (flags.tunnel) { delete config.noTunnel; }

  ensureRuntimeDir();
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log("Config saved:");
  console.log(JSON.stringify(config, null, 2));
}

async function launch() {
  const sub = args[0];
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, `${LAUNCH_LABEL}.plist`);

  if (sub === "stop") {
    if (!existsSync(plistPath)) {
      console.log("LaunchAgent not installed.");
      return;
    }
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }); } catch {}
    unlinkSync(plistPath);
    console.log("✓ WithAI LaunchAgent unloaded and removed.");
    return;
  }

  if (sub === "status") {
    if (!existsSync(plistPath)) {
      console.log("✗ LaunchAgent not installed");
      console.log("  Run: withai launch");
      return;
    }
    let pid = null;
    try {
      const output = execSync(`launchctl list ${LAUNCH_LABEL} 2>/dev/null`, { encoding: "utf8" });
      const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
      pid = pidMatch ? pidMatch[1] : null;
    } catch {}
    const healthy = await httpOk("http://127.0.0.1:4174/health");
    console.log(`✓ LaunchAgent installed: ${plistPath}`);
    console.log(`${pid ? "✓" : "✗"} Process: ${pid ? `PID ${pid}` : "not running"}`);
    console.log(`${healthy ? "✓" : "✗"} Server health: ${healthy ? "reachable" : "unreachable"}`);
    return;
  }

  // Install
  const config = readConfig();
  const port = Number(config.port || 4174);
  const nodePath = process.execPath;
  const scriptPath = join(installRoot, "src", "cli", "withai.mjs");
  const logsDir = join(store.workspaceDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(plistDir, { recursive: true });

  const programArgs = [nodePath, scriptPath, "start", "--port", String(port)];
  if (config.publicUrl) programArgs.push("--url", config.publicUrl);
  if (config.noTunnel) programArgs.push("--noTunnel");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logsDir, "withai.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logsDir, "withai.stderr.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WITHAI_ROOT</key>
    <string>${escapeXml(projectRoot)}</string>
    <key>PATH</key>
    <string>${escapeXml(process.env.PATH || "/usr/local/bin:/usr/bin:/bin")}</string>
  </dict>
</dict>
</plist>`;

  // Unload if already loaded (ignore errors on first install)
  if (existsSync(plistPath)) {
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }); } catch {}
  }

  writeFileSync(plistPath, plist);
  execSync(`launchctl load "${plistPath}"`);

  console.log("✓ WithAI LaunchAgent installed and loaded.");
  console.log(`  Plist: ${plistPath}`);
  console.log(`  Logs:  ${logsDir}/withai.stdout.log`);
  console.log(`  Port:  ${port}${config.publicUrl ? ` · Tunnel: ${config.publicUrl}` : ""}`);
  console.log("");
  console.log("  withai launch status   — check if running");
  console.log("  withai launch stop     — uninstall");
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readConfig() {
  const configPath = join(store.workspaceDir, "config.json");
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
}

function parseFlags(values) {
  const parsed = {};
  const rest = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) {
      rest.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  args.splice(0, args.length, ...rest);
  return parsed;
}

function argsRequired(count, usage) {
  if (args.length < count) throw new Error(`Usage: withai ${usage}`);
  return args;
}

function requiredFlag(name) {
  if (!flags[name]) throw new Error(`Missing --${name}`);
  return flags[name];
}

function resolveInputPath(value) {
  const candidates = [
    resolve(invocationCwd, value),
    resolve(projectRoot, value),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found || candidates[0];
}

function writeRuntime(value) {
  ensureRuntimeDir();
  writeFileSync(runtimePath(), `${JSON.stringify(value, null, 2)}\n`);
}

function readRuntime() {
  return existsSync(runtimePath()) ? JSON.parse(readFileSync(runtimePath(), "utf8")) : null;
}

function runtimePath() {
  return join(store.workspaceDir, "runtime.json");
}

function ensureRuntimeDir() {
  mkdirSync(dirname(runtimePath()), { recursive: true });
}

async function warnIfOriginUnavailable(origin) {
  if (flags.skipHealthCheck) return;
  const localOrigin = readRuntime()?.localOrigin || origin;
  const ok = await httpOk(`${localOrigin.replace(/\/$/, "")}/health`);
  if (ok) return;
  console.warn("Warning: WithAI server does not look reachable.");
  console.warn("Start it in another terminal first:");
  console.warn("  withai start --noTunnel --port 4174");
  console.warn("The review was still created, but the links will not open until the server is running.");
}

function printActiveReviews(origin) {
  const reviews = store.listReviews();
  if (!reviews.length) {
    console.log("No active reviews yet. Run: withai review <file.md>");
    return;
  }
  console.log("Active reviews:");
  for (const summary of reviews) {
    const review = store.getReview(summary.id);
    console.log(`- ${review.id}\t${review.currentRevisionId}\t${review.title}`);
    console.log(`  Review link: ${origin}/r/${review.id}/${review.shareSecret}`);
    console.log(`  Owner link:  ${origin}/r/${review.id}/${review.ownerToken}`);
  }
}

function printReviewLinks(review, origin) {
  console.log(`Review link (send to reviewer): ${origin}/r/${review.id}/${review.shareSecret}`);
  console.log(`Owner link  (keep for owner):          ${origin}/r/${review.id}/${review.ownerToken}`);
}

function findReviewBySource(sourcePath) {
  const reviews = store.listReviews();
  const match = reviews.find((item) => item.sourcePath === sourcePath);
  return match || null;
}

async function waitForNgrokOrigin() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const origin = await readNgrokOrigin();
    if (origin) return origin;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("no public tunnel URL found at ngrok API");
}

async function readNgrokOrigin() {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels");
    if (!response.ok) return "";
    const payload = await response.json();
    return payload.tunnels?.find((tunnel) => tunnel.public_url?.startsWith("https://"))?.public_url || "";
  } catch {
    return "";
  }
}

async function commandPath(commandName) {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(":")) {
    const candidate = join(dir, commandName);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function isWritable(path) {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function httpOk(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function mcpSmoke() {
  return existsSync(join(projectRoot, "src", "mcp", "withai-mcp.mjs"));
}

function printHelp() {
  console.log(`WithAI Markdown Review

Commands:
  withai start [--port 4174] [--url https://your-domain.ngrok.app] [--noTunnel]
  withai serve
  withai review <markdown-file> [--title <title>]
  withai share <markdown-file> [--title <title>]
  withai configure [--public-url <url>] [--port <port>] [--no-tunnel] [--reset]
  withai launch                      Install LaunchAgent (auto-start on login)
  withai launch status               Check daemon status
  withai launch stop                 Uninstall LaunchAgent
  withai create <markdown-file> [--title <title>] [--origin http://127.0.0.1:4173]
  withai list
  withai links <review-id>
  withai watch <review-id>
  withai publish <review-id> [markdown-file] [--author owner-agent]
  withai context <review-id> [--json]
  withai agent-comment <review-id> --token <token> --quote <quote> --body <body>
  withai bridge --server <url> --review <review-id> --token <token>
  withai bridge --server <url> --review <review-id> --token <token> --quote <quote> --body <body>
  withai doctor
  withai rotate <review-id> --owner|--reviewer
  withai revoke-agent <review-id> <agent_session_id>
`);
}
