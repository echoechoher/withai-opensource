import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { extractContext, locateQuote, charOffsetToLine } from "../markdown/quote-context.mjs";
import { buildLineDiff } from "../diff/line-diff.mjs";

export const DEFAULT_WORKSPACE_DIR = ".withai";

export function createReviewStore(options = {}) {
  const root = resolve(options.root || process.cwd());
  const workspaceDir = resolve(root, options.workspaceDir || DEFAULT_WORKSPACE_DIR);
  const reviewsDir = join(workspaceDir, "reviews");
  ensureDir(reviewsDir);

  return {
    root,
    workspaceDir,
    reviewsDir,
    createReview: (input) => createReview({ root, reviewsDir }, input),
    listReviews: () => listReviews(reviewsDir),
    getReview: (id) => getReview(reviewsDir, id),
    authorizeReview: (id, secret) => authorizeReview(reviewsDir, id, secret),
    getPublicReview: (id, secret) => getPublicReview(reviewsDir, id, secret),
    addComment: (id, input) => addComment(reviewsDir, id, input),
    resolveComment: (id, commentId, input = {}) => resolveComment(reviewsDir, id, commentId, input),
    editComment: (id, commentId, input = {}) => editComment(reviewsDir, id, commentId, input),
    reopenComment: (id, commentId) => reopenComment(reviewsDir, id, commentId),
    createAgentSession: (id, input = {}) => createAgentSession({ root, reviewsDir }, id, input),
    getAgentContext: (token) => getAgentContext(reviewsDir, token),
    addAgentComment: (input) => addAgentComment(reviewsDir, input),
    publishRevision: (id, input = {}) => publishRevision({ root, reviewsDir }, id, input),
    rotateToken: (id, kind) => rotateToken(reviewsDir, id, kind),
    revokeAgent: (id, sessionId) => revokeAgent(reviewsDir, id, sessionId),
    buildHistory: (id, fromRevisionId, toRevisionId) => buildHistory(reviewsDir, id, fromRevisionId, toRevisionId),
    writeAgentContext: (id) => writeAgentContext(reviewsDir, id),
    setWecomDoc: (id, wecomDocId, wecomDocUrl) => setWecomDoc(reviewsDir, id, wecomDocId, wecomDocUrl),
  };
}

function createReview(context, input) {
  const now = nowIso();
  const id = input.id || `r_${token(8)}`;
  const reviewDir = join(context.reviewsDir, id);
  ensureDir(join(reviewDir, "revisions"));

  const sourcePath = input.sourcePath ? resolve(context.root, input.sourcePath) : null;
  const markdown = input.markdown ?? (sourcePath ? readFileSync(sourcePath, "utf8") : "");
  if (!markdown.trim()) throw new Error("Review markdown is empty.");

  const title = input.title || titleFromMarkdown(markdown) || (sourcePath ? basename(sourcePath) : "Untitled Markdown");
  const revision = writeRevision(reviewDir, {
    id: "v1",
    markdown,
    author: input.author || "owner",
    createdAt: now,
  });

  const review = {
    id,
    title,
    sourcePath,
    createdAt: now,
    updatedAt: now,
    currentRevisionId: revision.id,
    shareSecret: token(18),
    ownerToken: `own_${token(18)}`,
    reviewerToken: `rev_${token(18)}`,
    versions: [revision.summary],
  };

  writeJson(join(reviewDir, "review.json"), review);
  writeJson(join(reviewDir, "comments.json"), []);
  writeJson(join(reviewDir, "agent-sessions.json"), []);
  writeJson(join(reviewDir, "events.json"), [{ type: "review.created", at: now, actor: input.author || "owner" }]);
  upsertIndex(context.reviewsDir, review);
  writeAgentContext(context.reviewsDir, id);
  return hydrateReview(context.reviewsDir, review);
}

function publishRevision(context, id, input) {
  const review = getReview(context.reviewsDir, id);
  const reviewDir = getReviewDir(context.reviewsDir, id);
  const markdown = input.markdown ?? readFileSync(resolve(context.root, input.sourcePath || review.sourcePath), "utf8");
  const currentRevision = readRevision(reviewDir, review.currentRevisionId);
  if (markdown === currentRevision.markdown) {
    return { ...hydrateReview(context.reviewsDir, review), unchanged: true };
  }
  const nextNumber = review.versions.length + 1;
  const revisionId = input.revisionId || `v${nextNumber}`;
  const revision = writeRevision(reviewDir, {
    id: revisionId,
    markdown,
    author: input.author || "owner-agent",
    createdAt: nowIso(),
  });

  review.currentRevisionId = revision.id;
  review.updatedAt = revision.summary.createdAt;
  review.versions.push(revision.summary);
  writeJson(join(reviewDir, "review.json"), review);
  appendEvent(reviewDir, { type: "revision.published", at: revision.summary.createdAt, actor: revision.summary.author, revisionId });
  upsertIndex(context.reviewsDir, review);
  writeAgentContext(context.reviewsDir, id);
  return hydrateReview(context.reviewsDir, review);
}

function getPublicReview(reviewsDir, id, secret) {
  const authorized = authorizeReview(reviewsDir, id, secret);
  return sanitizePayload(authorized.payload, authorized.viewer);
}

function authorizeReview(reviewsDir, id, secret) {
  const review = getReview(reviewsDir, id);
  let role = null;
  if (secret === review.ownerToken) role = "owner";
  if (secret === review.shareSecret || secret === review.reviewerToken) role = "reviewer";
  const session = role ? null : readAgentSessions(reviewsDir, id).find((item) => item.token === secret && item.status === "active");
  if (session) role = "agent";
  if (!role) throw Object.assign(new Error("Invalid review secret."), { statusCode: 403 });

  return {
    payload: hydrateReview(reviewsDir, review),
    viewer: {
      role,
      canRead: true,
      canComment: true,
      canCreateAgentSession: role !== "agent",
      canResolve: role === "owner" || role === "agent",
      canPublish: role === "owner",
    },
  };
}

function hydrateReview(reviewsDir, review) {
  const revision = readRevision(getReviewDir(reviewsDir, review.id), review.currentRevisionId);
  const comments = readComments(reviewsDir, review.id);
  return {
    review,
    document: {
      title: review.title,
      revisionId: revision.id,
      format: "Markdown",
      sourcePath: review.sourcePath,
      markdown: revision.markdown,
    },
    comments,
    contextPath: join(getReviewDir(reviewsDir, review.id), "context.md"),
  };
}

function sanitizePayload(payload, viewer) {
  const { shareSecret, ownerToken, reviewerToken, ...publicReview } = payload.review;
  return {
    ...payload,
    review: publicReview,
    viewer,
  };
}

function addComment(reviewsDir, id, input) {
  const review = getReview(reviewsDir, id);
  const revision = readRevision(getReviewDir(reviewsDir, id), review.currentRevisionId);
  const comments = readComments(reviewsDir, id);
  const now = nowIso();
  const anchor = normalizeAnchor(input.anchor, revision.markdown);
  const comment = {
    id: `c_${stableId(`${input.author}:${anchor.quote}:${input.body}:${now}`)}`,
    revisionId: input.revisionId || review.currentRevisionId,
    author: input.author || "owner",
    authorType: input.authorType || "human",
    body: String(input.body || "").trim(),
    anchor,
    status: "open",
    createdAt: now,
    replies: [],
  };
  if (!comment.body) throw Object.assign(new Error("Comment body is required."), { statusCode: 400 });

  comments.unshift(comment);
  writeComments(reviewsDir, id, comments);
  appendEvent(getReviewDir(reviewsDir, id), { type: "comment.created", at: now, actor: comment.author, commentId: comment.id });
  writeAgentContext(reviewsDir, id);
  return comment;
}

function resolveComment(reviewsDir, id, commentId, input = {}) {
  const comments = readComments(reviewsDir, id);
  const comment = comments.find((item) => item.id === commentId);
  if (!comment) throw Object.assign(new Error("Comment not found."), { statusCode: 404 });
  comment.status = "resolved";
  comment.resolvedAt = nowIso();
  comment.resolvedBy = input.actor || "owner";
  writeComments(reviewsDir, id, comments);
  appendEvent(getReviewDir(reviewsDir, id), { type: "comment.resolved", at: comment.resolvedAt, actor: comment.resolvedBy, commentId });
  writeAgentContext(reviewsDir, id);
  return comment;
}

function editComment(reviewsDir, id, commentId, input = {}) {
  const comments = readComments(reviewsDir, id);
  const comment = comments.find((item) => item.id === commentId);
  if (!comment) throw Object.assign(new Error("Comment not found."), { statusCode: 404 });
  const newBody = String(input.body || "").trim();
  if (!newBody) throw Object.assign(new Error("Comment body is required."), { statusCode: 400 });
  comment.body = newBody;
  comment.editedAt = nowIso();
  writeComments(reviewsDir, id, comments);
  appendEvent(getReviewDir(reviewsDir, id), { type: "comment.edited", at: comment.editedAt, actor: input.actor || "owner", commentId });
  writeAgentContext(reviewsDir, id);
  return comment;
}

function reopenComment(reviewsDir, id, commentId) {
  const comments = readComments(reviewsDir, id);
  const comment = comments.find((item) => item.id === commentId);
  if (!comment) throw Object.assign(new Error("Comment not found."), { statusCode: 404 });
  comment.status = "open";
  delete comment.resolvedAt;
  delete comment.resolvedBy;
  writeComments(reviewsDir, id, comments);
  writeAgentContext(reviewsDir, id);
  return comment;
}

function createAgentSession(context, id, input = {}) {
  const review = getReview(context.reviewsDir, id);
  const sessions = readAgentSessions(context.reviewsDir, id);
  const session = {
    id: `as_${token(8)}`,
    reviewId: id,
    author: input.author || "reviewer-agent",
    authorType: "agent",
    pairCode: token(4),
    token: `agt_${token(18)}`,
    status: "active",
    createdAt: nowIso(),
  };
  sessions.unshift(session);
  writeJson(join(getReviewDir(context.reviewsDir, id), "agent-sessions.json"), sessions);
  appendEvent(getReviewDir(context.reviewsDir, id), { type: "agent_session.created", at: session.createdAt, actor: session.author, sessionId: session.id });
  const server = input.server || "<review_server>";
  const bridgeCommand = `withai bridge --server ${shellQuote(server)} --review ${shellQuote(review.id)} --token ${shellQuote(session.token)}`;
  const defaultPrompt = [
    "你是 reviewer 的本地 agent，代表 reviewer 对这篇文档做 review。",
    "",
    "背景：",
    "- 先浏览当前工作目录中的相关文件，理解项目上下文和 reviewer 的关注点",
    "- 基于你对项目、团队、reviewer 角色的理解来做判断",
    "",
    "规则：",
    "- 读完文档后，对需要调整的地方写 comment",
    "- 从文档中精确选取原文作为 quote，用 --quote 参数写入",
    "- comment 要短、具体、可执行——像 reviewer 本人会说的话",
    "- 不要改 Markdown 正文，只写 comment",
  ].join("\n");
  return {
    ...session,
    command: bridgeCommand,
    writeCommand: `${bridgeCommand} --quote "<原文引用>" --body "<你的 comment>"`,
    prompt: defaultPrompt,
  };
}

function getAgentContext(reviewsDir, tokenValue) {
  const session = listAllAgentSessions(reviewsDir).find((item) => item.token === tokenValue && item.status === "active");
  if (!session) throw Object.assign(new Error("Invalid agent token."), { statusCode: 403 });
  const payload = hydrateReview(reviewsDir, getReview(reviewsDir, session.reviewId));
  const { token: _token, ...publicSession } = session;
  const { shareSecret, ownerToken, reviewerToken, ...publicReview } = payload.review;
  return {
    task: buildAgentTask({ server: "", reviewId: payload.review.id, token: "" }),
    session: publicSession,
    review: publicReview,
    document: payload.document,
    comments: payload.comments,
    rules: {
      canWriteComments: true,
      canEditMarkdown: false,
      canResolve: true,
    },
  };
}

function addAgentComment(reviewsDir, input) {
  const sessions = listAllAgentSessions(reviewsDir);
  const session = sessions.find((item) => item.token === input.token && item.status === "active");
  if (!session) throw Object.assign(new Error("Invalid agent token."), { statusCode: 403 });
  return addComment(reviewsDir, session.reviewId, {
    ...input,
    author: input.author || session.author,
    authorType: "agent",
  });
}

function buildHistory(reviewsDir, id, fromRevisionId, toRevisionId) {
  const review = getReview(reviewsDir, id);
  const reviewDir = getReviewDir(reviewsDir, id);
  const toId = toRevisionId || review.currentRevisionId;
  const toIndex = review.versions.findIndex((item) => item.id === toId);
  const fromId = fromRevisionId || review.versions[Math.max(0, toIndex - 1)]?.id || review.versions[0]?.id;
  const fromRevision = readRevision(reviewDir, fromId);
  const toRevision = readRevision(reviewDir, toId);
  const diff = buildLineDiff(fromRevision.markdown, toRevision.markdown);
  const comments = readComments(reviewsDir, id);
  const commentReferences = attachCommentReferences(comments, diff.changedRanges, toRevision.markdown);
  return {
    review: { id: review.id, title: review.title, currentRevisionId: review.currentRevisionId },
    versions: review.versions,
    fromRevision: fromRevision.summary,
    toRevision: toRevision.summary,
    diff: { ...diff, commentReferences },
  };
}

function attachCommentReferences(comments, changedRanges, markdown) {
  if (!changedRanges || !changedRanges.length) return [];
  const results = [];
  for (const range of changedRanges) {
    const related = comments.filter((comment) => {
      if (!comment.anchor || !comment.anchor.quote) return false;
      const loc = locateQuote(markdown, comment.anchor);
      if (!loc) return false;
      const startLine = charOffsetToLine(markdown, loc.start);
      const endLine = charOffsetToLine(markdown, loc.end);
      return startLine <= range.newEnd && endLine >= range.newStart;
    });
    if (related.length) {
      results.push({ ...range, comments: related.map((c) => ({ id: c.id, author: c.author, body: c.body, status: c.status })) });
    }
  }
  return results;
}

function writeAgentContext(reviewsDir, id) {
  const review = getReview(reviewsDir, id);
  const payload = hydrateReview(reviewsDir, review);
  const reviewDir = getReviewDir(reviewsDir, id);
  const openComments = payload.comments.filter((comment) => comment.status === "open");
  const resolvedComments = payload.comments.filter((comment) => comment.status === "resolved");
  const { shareSecret, ownerToken, reviewerToken, ...publicReview } = payload.review;
  const contextPayload = {
    review: publicReview,
    document: payload.document,
    comments: payload.comments.map((c) => ({ id: c.id, author: c.author, body: c.body, quote: c.anchor?.quote || "", status: c.status })),
    task: buildAgentTask({ server: "", reviewId: review.id, token: "" }),
    rules: {
      canWriteComments: true,
      canEditMarkdown: false,
      canResolve: true,
    },
  };
  const context = [
    `# WithAI Review Context: ${review.title}`,
    "",
    `Review ID: ${review.id}`,
    `Current revision: ${review.currentRevisionId}`,
    review.sourcePath ? `Local source: ${review.sourcePath}` : null,
    "",
    `Open comments: ${openComments.length}`,
    `Resolved comments: ${resolvedComments.length}`,
    "",
    "## Open comments",
    "",
    ...openComments.flatMap((comment) => [
      `### ${comment.id} · ${comment.author}`,
      `Quote: "${comment.anchor.quote}"`,
      "",
      comment.body,
      "",
    ]),
  ].filter(Boolean).join("\n");

  writeFileSync(join(reviewDir, "context.md"), `${context}\n`);
  writeJson(join(reviewDir, "context.json"), contextPayload);
  return { md: join(reviewDir, "context.md"), json: join(reviewDir, "context.json") };
}

function buildAgentTask({ server, reviewId, token: tokenValue }) {
  return {
    intent: "Read this Markdown review context and write structured WithAI comments. Do not only return suggestions in chat.",
    canWriteComments: true,
    canEditMarkdown: false,
    canResolve: true,
    writeEndpoint: server ? `${server}/api/agent/comments` : "/api/agent/comments",
    resolveEndpoint: server ? `${server}/api/agent/resolve` : "/api/agent/resolve",
    reviewId,
    tokenHint: tokenValue ? "agent token is embedded in the command" : "agent token is provided by the agent session command",
  };
}

function writeRevision(reviewDir, input) {
  const revisionDir = join(reviewDir, "revisions");
  ensureDir(revisionDir);
  writeFileSync(join(revisionDir, `${input.id}.md`), input.markdown);
  const summary = {
    id: input.id,
    author: input.author,
    createdAt: input.createdAt,
  };
  return { id: input.id, markdown: input.markdown, summary };
}

function readRevision(reviewDir, revisionId) {
  const markdown = readFileSync(join(reviewDir, "revisions", `${revisionId}.md`), "utf8");
  return {
    id: revisionId,
    markdown,
    summary: readJson(join(reviewDir, "review.json")).versions.find((item) => item.id === revisionId),
  };
}

function normalizeAnchor(anchor = {}, markdown = "") {
  const quote = String(anchor.quote || "").trim();
  let before = String(anchor.before || "").trim();
  let after = String(anchor.after || "").trim();
  if (quote && markdown && !before && !after) {
    const ctx = extractContext(markdown, quote);
    before = ctx.before;
    after = ctx.after;
  }
  return { quote, before, after };
}

function stableId(input, length = 10) {
  return createHash("sha1").update(input).digest("hex").slice(0, length);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function rotateToken(reviewsDir, id, kind) {
  const review = getReview(reviewsDir, id);
  if (kind === "owner") review.ownerToken = `own_${token(18)}`;
  else if (kind === "reviewer") {
    review.shareSecret = token(18);
    review.reviewerToken = `rev_${token(18)}`;
  } else {
    throw Object.assign(new Error("Token kind must be owner or reviewer."), { statusCode: 400 });
  }
  review.updatedAt = nowIso();
  writeJson(join(getReviewDir(reviewsDir, id), "review.json"), review);
  appendEvent(getReviewDir(reviewsDir, id), { type: "token.rotated", at: review.updatedAt, kind });
  upsertIndex(reviewsDir, review);
  return review;
}

function revokeAgent(reviewsDir, id, sessionId) {
  const sessions = readAgentSessions(reviewsDir, id);
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) throw Object.assign(new Error("Agent session not found."), { statusCode: 404 });
  session.status = "revoked";
  session.revokedAt = nowIso();
  writeJson(join(getReviewDir(reviewsDir, id), "agent-sessions.json"), sessions);
  appendEvent(getReviewDir(reviewsDir, id), { type: "agent_session.revoked", at: session.revokedAt, actor: "owner", sessionId });
  return session;
}

function setWecomDoc(reviewsDir, id, wecomDocId, wecomDocUrl) {
  const review = getReview(reviewsDir, id);
  review.wecomDocId = wecomDocId;
  review.wecomDocUrl = wecomDocUrl;
  review.updatedAt = nowIso();
  writeJson(join(getReviewDir(reviewsDir, id), "review.json"), review);
  appendEvent(getReviewDir(reviewsDir, id), { type: "wecom.pushed", at: review.updatedAt, wecomDocUrl });
  return review;
}

function getReview(reviewsDir, id) {
  const reviewPath = join(getReviewDir(reviewsDir, id), "review.json");
  if (!existsSync(reviewPath)) throw Object.assign(new Error("Review not found."), { statusCode: 404 });
  return readJson(reviewPath);
}

function getReviewDir(reviewsDir, id) {
  return join(reviewsDir, id);
}

function readComments(reviewsDir, id) {
  return readJson(join(getReviewDir(reviewsDir, id), "comments.json"));
}

function writeComments(reviewsDir, id, comments) {
  writeJson(join(getReviewDir(reviewsDir, id), "comments.json"), comments);
}

function readAgentSessions(reviewsDir, id) {
  return readJson(join(getReviewDir(reviewsDir, id), "agent-sessions.json"));
}

function listAllAgentSessions(reviewsDir) {
  return listReviews(reviewsDir).flatMap((review) => readAgentSessions(reviewsDir, review.id));
}

function listReviews(reviewsDir) {
  const path = join(reviewsDir, "index.json");
  return existsSync(path) ? readJson(path) : [];
}

function upsertIndex(reviewsDir, review) {
  const index = listReviews(reviewsDir).filter((item) => item.id !== review.id);
  index.unshift({ id: review.id, title: review.title, sourcePath: review.sourcePath, updatedAt: review.updatedAt, currentRevisionId: review.currentRevisionId });
  writeJson(join(reviewsDir, "index.json"), index);
}

function appendEvent(reviewDir, event) {
  const path = join(reviewDir, "events.json");
  const events = existsSync(path) ? readJson(path) : [];
  events.push(event);
  writeJson(path, events);
}

function titleFromMarkdown(markdown) {
  const heading = String(markdown).split("\n").find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : "";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function token(bytes) {
  return randomBytes(bytes).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}
