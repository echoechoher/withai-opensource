/**
 * Comprehensive test suite for WithAI quote-context system.
 * Covers: quote-context utilities, store operations, HTTP API, edge cases.
 *
 * Run: node scripts/withai-test-suite.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { extractContext, locateQuote, charOffsetToLine } from "../src/server/markdown/quote-context.mjs";
import { createWithAiServer } from "../src/server/app.mjs";
import { createReviewStore } from "../src/server/store/review-store.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

// ============================================================
// Part 1: quote-context.mjs unit tests
// ============================================================

const sampleMd = `# Title

First paragraph with some content.

Same text appears here.

## Section Two

Another paragraph in section two.

Same text appears here.

Final line.
`;

test("extractContext: basic", () => {
  const ctx = extractContext(sampleMd, "First paragraph");
  assert.equal(ctx.quote, "First paragraph");
  assert.ok(ctx.before.includes("Title"));
  assert.ok(ctx.after.includes("with some content"));
});

test("extractContext: quote not found", () => {
  const ctx = extractContext(sampleMd, "nonexistent text");
  assert.equal(ctx.quote, "nonexistent text");
  assert.equal(ctx.before, "");
  assert.equal(ctx.after, "");
});

test("extractContext: empty quote", () => {
  const ctx = extractContext(sampleMd, "");
  assert.equal(ctx.quote, "");
  assert.equal(ctx.before, "");
  assert.equal(ctx.after, "");
});

test("extractContext: empty markdown", () => {
  const ctx = extractContext("", "hello");
  assert.equal(ctx.before, "");
  assert.equal(ctx.after, "");
});

test("extractContext: quote at very beginning", () => {
  const ctx = extractContext(sampleMd, "# Title");
  assert.equal(ctx.before, "");
  assert.ok(ctx.after.length > 0);
});

test("extractContext: quote at very end", () => {
  const md = "Hello world. End.";
  const ctx = extractContext(md, "End.");
  assert.ok(ctx.before.includes("Hello"));
  assert.equal(ctx.after, "");
});

test("extractContext: custom radius", () => {
  const ctx = extractContext(sampleMd, "First paragraph", 10);
  assert.ok(ctx.before.length <= 10);
  assert.ok(ctx.after.length <= 10);
});

test("extractContext: multiline quote", () => {
  const md = "Line one.\nLine two.\nLine three.";
  const ctx = extractContext(md, "Line two.\nLine three.");
  assert.ok(ctx.before.includes("Line one"));
  assert.equal(ctx.after, "");
});

test("locateQuote: single occurrence", () => {
  const loc = locateQuote(sampleMd, { quote: "First paragraph with some content." });
  assert.ok(loc);
  assert.equal(sampleMd.slice(loc.start, loc.end), "First paragraph with some content.");
});

test("locateQuote: multiple occurrences, disambiguate with before", () => {
  const loc = locateQuote(sampleMd, { quote: "Same text appears here.", before: "First paragraph with some content.\n\n" });
  assert.ok(loc);
  // Should match the FIRST occurrence (after first paragraph)
  assert.ok(loc.start < 80);
});

test("locateQuote: multiple occurrences, disambiguate with after", () => {
  const loc = locateQuote(sampleMd, { quote: "Same text appears here.", after: "\n\nFinal line." });
  assert.ok(loc);
  // Should match the SECOND occurrence (near end)
  assert.ok(loc.start > 80);
});

test("locateQuote: multiple occurrences, no context → first match", () => {
  const loc = locateQuote(sampleMd, { quote: "Same text appears here." });
  assert.ok(loc);
  // Should default to first match
  const firstIdx = sampleMd.indexOf("Same text appears here.");
  assert.equal(loc.start, firstIdx);
});

test("locateQuote: not found → null", () => {
  const loc = locateQuote(sampleMd, { quote: "does not exist" });
  assert.equal(loc, null);
});

test("locateQuote: null anchor → null", () => {
  assert.equal(locateQuote(sampleMd, null), null);
  assert.equal(locateQuote(sampleMd, {}), null);
  assert.equal(locateQuote(sampleMd, { quote: "" }), null);
});

test("locateQuote: empty markdown → null", () => {
  assert.equal(locateQuote("", { quote: "hello" }), null);
});

test("charOffsetToLine: first line", () => {
  assert.equal(charOffsetToLine("abc\ndef\nghi", 0), 1);
  assert.equal(charOffsetToLine("abc\ndef\nghi", 2), 1);
});

test("charOffsetToLine: second line", () => {
  assert.equal(charOffsetToLine("abc\ndef\nghi", 4), 2);
  assert.equal(charOffsetToLine("abc\ndef\nghi", 6), 2);
});

test("charOffsetToLine: third line", () => {
  assert.equal(charOffsetToLine("abc\ndef\nghi", 8), 3);
});

test("charOffsetToLine: offset at newline char", () => {
  // offset=3 means "position just before index 3", loop checks i<3 so \n at 3 is NOT counted
  assert.equal(charOffsetToLine("abc\ndef", 3), 1);
  // offset=4 means loop checks i<4, hits \n at index 3 → line 2
  assert.equal(charOffsetToLine("abc\ndef", 4), 2);
});

// ============================================================
// Part 2: Store — normalizeAnchor
// ============================================================

const storeRoot = mkdtempSync(join(tmpdir(), "withai-suite-"));
const storeMdPath = join(storeRoot, "test.md");
writeFileSync(storeMdPath, sampleMd);
const store = createReviewStore({ root: storeRoot });
const review = store.createReview({ sourcePath: storeMdPath, author: "owner" });

test("normalizeAnchor: auto-derives before/after from markdown", () => {
  const comment = store.addComment(review.review.id, {
    author: "reviewer", body: "test", anchor: { quote: "First paragraph" },
  });
  assert.ok(comment.anchor.before.length > 0);
  assert.ok(comment.anchor.after.length > 0);
});

test("normalizeAnchor: keeps explicit before/after", () => {
  const comment = store.addComment(review.review.id, {
    author: "reviewer", body: "test2",
    anchor: { quote: "Same text", before: "custom before", after: "custom after" },
  });
  assert.equal(comment.anchor.before, "custom before");
  assert.equal(comment.anchor.after, "custom after");
});

test("normalizeAnchor: trims whitespace from quote", () => {
  const comment = store.addComment(review.review.id, {
    author: "reviewer", body: "test3", anchor: { quote: "  First paragraph  " },
  });
  assert.equal(comment.anchor.quote, "First paragraph");
});

test("normalizeAnchor: empty quote still works", () => {
  const comment = store.addComment(review.review.id, {
    author: "reviewer", body: "general comment", anchor: { quote: "" },
  });
  assert.equal(comment.anchor.quote, "");
  assert.equal(comment.anchor.before, "");
  assert.equal(comment.anchor.after, "");
});

// ============================================================
// Part 3: Store — addComment edge cases
// ============================================================

test("addComment: empty body throws 400", () => {
  assert.throws(
    () => store.addComment(review.review.id, { author: "reviewer", body: "", anchor: { quote: "x" } }),
    /Comment body is required/,
  );
});

test("addComment: whitespace-only body throws 400", () => {
  assert.throws(
    () => store.addComment(review.review.id, { author: "reviewer", body: "   ", anchor: { quote: "x" } }),
    /Comment body is required/,
  );
});

test("addComment: missing anchor gracefully defaults", () => {
  const comment = store.addComment(review.review.id, {
    author: "reviewer", body: "no anchor test",
  });
  assert.equal(comment.anchor.quote, "");
});

// ============================================================
// Part 4: Store — publishRevision
// ============================================================

test("publishRevision: unchanged markdown returns unchanged=true", () => {
  const result = store.publishRevision(review.review.id, { markdown: sampleMd });
  assert.equal(result.unchanged, true);
});

test("publishRevision: new content creates v2", () => {
  const newMd = sampleMd + "\nAppended content.\n";
  writeFileSync(storeMdPath, newMd);
  const result = store.publishRevision(review.review.id, {});
  assert.equal(result.review.currentRevisionId, "v2");
  assert.equal(result.unchanged, undefined);
});

test("publishRevision: comments survive across versions", () => {
  const authorized = store.authorizeReview(review.review.id, review.review.ownerToken);
  assert.ok(authorized.payload.comments.length >= 4);
});

test("publishRevision: document has no blocks", () => {
  const authorized = store.authorizeReview(review.review.id, review.review.ownerToken);
  assert.equal(authorized.payload.document.blocks, undefined);
});

// ============================================================
// Part 5: Store — resolve, edit, reopen
// ============================================================

const resolveTestRoot = mkdtempSync(join(tmpdir(), "withai-resolve-"));
writeFileSync(join(resolveTestRoot, "r.md"), "# Resolve test\n\nSome paragraph.\n");
const resolveStore = createReviewStore({ root: resolveTestRoot });
const resolveReview = resolveStore.createReview({ sourcePath: join(resolveTestRoot, "r.md") });
const rComment = resolveStore.addComment(resolveReview.review.id, {
  author: "reviewer", body: "needs fix", anchor: { quote: "Some paragraph." },
});

test("resolveComment: sets status and metadata", () => {
  const resolved = resolveStore.resolveComment(resolveReview.review.id, rComment.id, { actor: "owner" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "owner");
  assert.ok(resolved.resolvedAt);
});

test("reopenComment: resets resolved state", () => {
  const reopened = resolveStore.reopenComment(resolveReview.review.id, rComment.id);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.resolvedAt, undefined);
  assert.equal(reopened.resolvedBy, undefined);
});

test("editComment: updates body and sets editedAt", () => {
  const edited = resolveStore.editComment(resolveReview.review.id, rComment.id, { body: "updated body" });
  assert.equal(edited.body, "updated body");
  assert.ok(edited.editedAt);
});

test("editComment: empty body throws", () => {
  assert.throws(
    () => resolveStore.editComment(resolveReview.review.id, rComment.id, { body: "" }),
    /Comment body is required/,
  );
});

test("resolveComment: nonexistent comment throws 404", () => {
  assert.throws(
    () => resolveStore.resolveComment(resolveReview.review.id, "c_fake"),
    /Comment not found/,
  );
});

// ============================================================
// Part 6: Store — createReview edge cases
// ============================================================

test("createReview: empty markdown throws", () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "withai-empty-"));
  const emptyMd = join(emptyRoot, "empty.md");
  writeFileSync(emptyMd, "  \n  \n");
  const emptyStore = createReviewStore({ root: emptyRoot });
  assert.throws(
    () => emptyStore.createReview({ sourcePath: emptyMd }),
    /Review markdown is empty/,
  );
});

test("createReview: custom title used over heading", () => {
  const tRoot = mkdtempSync(join(tmpdir(), "withai-title-"));
  writeFileSync(join(tRoot, "t.md"), "# Auto Title\n\nBody.\n");
  const tStore = createReviewStore({ root: tRoot });
  const r = tStore.createReview({ sourcePath: join(tRoot, "t.md"), title: "Custom" });
  assert.equal(r.review.title, "Custom");
});

test("createReview: title auto-detected from heading", () => {
  const tRoot = mkdtempSync(join(tmpdir(), "withai-autotitle-"));
  writeFileSync(join(tRoot, "t.md"), "# My Document\n\nContent.\n");
  const tStore = createReviewStore({ root: tRoot });
  const r = tStore.createReview({ sourcePath: join(tRoot, "t.md") });
  assert.equal(r.review.title, "My Document");
});

// ============================================================
// Part 7: Store — agent operations
// ============================================================

const agentRoot = mkdtempSync(join(tmpdir(), "withai-agent-"));
writeFileSync(join(agentRoot, "a.md"), "# Agent Test\n\nTarget paragraph.\n");
const agentStore = createReviewStore({ root: agentRoot });
const agentReview = agentStore.createReview({ sourcePath: join(agentRoot, "a.md") });
const agentSession = agentStore.createAgentSession(agentReview.review.id, { author: "test-agent" });

test("createAgentSession: token format", () => {
  assert.ok(agentSession.token.startsWith("agt_"));
  assert.ok(agentSession.id.startsWith("as_"));
});

test("addAgentComment: works with valid token", () => {
  const comment = agentStore.addAgentComment({
    token: agentSession.token,
    body: "Agent says fix this",
    anchor: { quote: "Target paragraph." },
  });
  assert.equal(comment.authorType, "agent");
  assert.equal(comment.author, "test-agent");
});

test("addAgentComment: invalid token throws 403", () => {
  assert.throws(
    () => agentStore.addAgentComment({ token: "agt_fake", body: "x", anchor: { quote: "x" } }),
    /Invalid agent token/,
  );
});

test("revokeAgent: revoked token cannot write", () => {
  agentStore.revokeAgent(agentReview.review.id, agentSession.id);
  assert.throws(
    () => agentStore.addAgentComment({ token: agentSession.token, body: "x", anchor: { quote: "x" } }),
    /Invalid agent token/,
  );
});

test("getAgentContext: shape is correct (no blocks)", () => {
  const session2 = agentStore.createAgentSession(agentReview.review.id, { author: "agent2" });
  const ctx = agentStore.getAgentContext(session2.token);
  assert.ok(ctx.document.markdown);
  assert.equal(ctx.document.blocks, undefined);
  assert.ok(ctx.comments.length > 0);
  assert.ok(ctx.comments[0].anchor.quote !== undefined);
  assert.equal(ctx.review.ownerToken, undefined);
  assert.equal(ctx.rules.canResolve, true);
});

// ============================================================
// Part 8: Store — permissions
// ============================================================

test("authorizeReview: owner can resolve and publish", () => {
  const auth = agentStore.authorizeReview(agentReview.review.id, agentReview.review.ownerToken);
  assert.equal(auth.viewer.canResolve, true);
  assert.equal(auth.viewer.canPublish, true);
});

test("authorizeReview: reviewer cannot resolve or publish", () => {
  const auth = agentStore.authorizeReview(agentReview.review.id, agentReview.review.shareSecret);
  assert.equal(auth.viewer.canResolve, false);
  assert.equal(auth.viewer.canPublish, false);
});

test("authorizeReview: invalid secret throws 403", () => {
  assert.throws(
    () => agentStore.authorizeReview(agentReview.review.id, "bad_secret"),
    /Invalid review secret/,
  );
});

test("rotateToken: old reviewer token invalidated", () => {
  const oldSecret = agentReview.review.shareSecret;
  agentStore.rotateToken(agentReview.review.id, "reviewer");
  assert.throws(
    () => agentStore.authorizeReview(agentReview.review.id, oldSecret),
    /Invalid review secret/,
  );
});

// ============================================================
// Part 9: Store — buildHistory and attachCommentReferences
// ============================================================

const histRoot = mkdtempSync(join(tmpdir(), "withai-hist-"));
writeFileSync(join(histRoot, "h.md"), "Line one.\nLine two.\nLine three.\n");
const histStore = createReviewStore({ root: histRoot });
const histReview = histStore.createReview({ sourcePath: join(histRoot, "h.md") });
histStore.addComment(histReview.review.id, {
  author: "reviewer", body: "fix line two", anchor: { quote: "Line two." },
});

test("buildHistory: single version shows no diff", () => {
  const history = histStore.buildHistory(histReview.review.id);
  // With only one version, from and to are the same
  assert.ok(!history.diff.rows.some((r) => r.type !== "context"));
});

// Add a comment that will still exist in v2 (on "Line three." which stays)
histStore.addComment(histReview.review.id, {
  author: "reviewer", body: "comment on line three", anchor: { quote: "Line three." },
});

writeFileSync(join(histRoot, "h.md"), "Line one.\nLine two CHANGED.\nLine three.\nLine four added.\n");
histStore.publishRevision(histReview.review.id, {});

// Add a comment on text that exists in v2 and is within a changed range
histStore.addComment(histReview.review.id, {
  author: "reviewer", body: "comment on new line", anchor: { quote: "Line four added." },
});

test("buildHistory: two versions shows changes", () => {
  const history = histStore.buildHistory(histReview.review.id);
  assert.ok(history.diff.rows.some((r) => r.type === "add"));
  assert.ok(history.diff.rows.some((r) => r.type === "remove"));
});

test("buildHistory: commentReferences links comments to changed ranges", () => {
  const history = histStore.buildHistory(histReview.review.id);
  const refs = history.diff.commentReferences;
  const hasRef = refs.some((r) => r.comments.some((c) => c.body === "comment on new line"));
  assert.ok(hasRef, "Comment on added line should reference the changed range");
});

test("buildHistory: comment with stale quote not in references", () => {
  histStore.addComment(histReview.review.id, {
    author: "reviewer", body: "stale comment", anchor: { quote: "nonexistent text" },
  });
  const history = histStore.buildHistory(histReview.review.id);
  const refs = history.diff.commentReferences;
  const hasStale = refs.some((r) => r.comments.some((c) => c.body === "stale comment"));
  assert.equal(hasStale, false);
});

// ============================================================
// Part 10: Store — writeAgentContext shape
// ============================================================

test("writeAgentContext: context.json has correct shape", () => {
  const paths = histStore.writeAgentContext(histReview.review.id);
  const ctx = JSON.parse(readFileSync(paths.json, "utf8"));
  assert.ok(ctx.document.markdown);
  assert.equal(ctx.document.blocks, undefined);
  assert.ok(Array.isArray(ctx.comments));
  assert.ok(ctx.comments[0].id);
  assert.ok(ctx.comments[0].quote !== undefined);
  assert.ok(ctx.comments[0].body);
  assert.equal(ctx.review.ownerToken, undefined);
  assert.equal(ctx.review.shareSecret, undefined);
});

test("writeAgentContext: context.md is readable text", () => {
  const paths = histStore.writeAgentContext(histReview.review.id);
  const md = readFileSync(paths.md, "utf8");
  assert.match(md, /WithAI Review Context/);
  assert.match(md, /Open comments: \d+/);
  assert.match(md, /Quote: "/);
});

// ============================================================
// Part 11: Unicode and special characters
// ============================================================

const unicodeRoot = mkdtempSync(join(tmpdir(), "withai-unicode-"));
const unicodeMd = `# 中文标题

这是一段中文内容，包含 emoji 🎉 和特殊字符 *bold* \`code\`。

第二段也有中文。Same text 重复。

第三段。Same text 重复。
`;
writeFileSync(join(unicodeRoot, "u.md"), unicodeMd);
const unicodeStore = createReviewStore({ root: unicodeRoot });
const unicodeReview = unicodeStore.createReview({ sourcePath: join(unicodeRoot, "u.md") });

test("unicode: comment on Chinese text", () => {
  const comment = unicodeStore.addComment(unicodeReview.review.id, {
    author: "reviewer", body: "中文评论",
    anchor: { quote: "中文内容，包含 emoji 🎉" },
  });
  assert.equal(comment.anchor.quote, "中文内容，包含 emoji 🎉");
  assert.ok(comment.anchor.before.includes("中文标题"));
});

test("unicode: disambiguate Chinese duplicate", () => {
  const loc1 = locateQuote(unicodeMd, { quote: "Same text 重复。", before: "第二段也有中文。" });
  const loc2 = locateQuote(unicodeMd, { quote: "Same text 重复。", before: "第三段。" });
  assert.ok(loc1);
  assert.ok(loc2);
  assert.ok(loc1.start < loc2.start);
});

test("unicode: markdown special chars in quote", () => {
  const comment = unicodeStore.addComment(unicodeReview.review.id, {
    author: "reviewer", body: "test",
    anchor: { quote: "*bold* `code`" },
  });
  assert.equal(comment.anchor.quote, "*bold* `code`");
});

// ============================================================
// Part 12: HTTP API tests
// ============================================================

const httpRoot = mkdtempSync(join(tmpdir(), "withai-http-"));
writeFileSync(join(httpRoot, "api.md"), "# API Test\n\nParagraph for API.\n\nAnother paragraph.\n");
const httpStore = createReviewStore({ root: httpRoot });
const httpReview = httpStore.createReview({ sourcePath: join(httpRoot, "api.md") });
const server = createWithAiServer({ root: httpRoot });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

await testAsync("HTTP: GET /health", async () => {
  const res = await fetch(`${origin}/health`);
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(data.ok, true);
});

await testAsync("HTTP: GET /api/reviews (list)", async () => {
  const res = await fetch(`${origin}/api/reviews`);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.length >= 1);
});

await testAsync("HTTP: GET /api/reviews/:id with valid secret", async () => {
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}?secret=${httpReview.review.ownerToken}`);
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(data.document.blocks, undefined);
  assert.ok(data.document.markdown.includes("API Test"));
});

await testAsync("HTTP: GET /api/reviews/:id with invalid secret → 403", async () => {
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}?secret=invalid`);
  assert.equal(res.status, 403);
});

await testAsync("HTTP: POST comment with quote anchor", async () => {
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}/comments?secret=${httpReview.review.ownerToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author: "owner", body: "HTTP comment", anchor: { quote: "Paragraph for API." } }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.anchor.quote, "Paragraph for API.");
  assert.ok(data.anchor.before.length > 0);
});

await testAsync("HTTP: POST comment with empty body → 400", async () => {
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}/comments?secret=${httpReview.review.ownerToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author: "owner", body: "", anchor: { quote: "x" } }),
  });
  assert.equal(res.status, 400);
});

await testAsync("HTTP: PATCH comment (resolve)", async () => {
  const comments = httpStore.authorizeReview(httpReview.review.id, httpReview.review.ownerToken).payload.comments;
  const commentId = comments[0].id;
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}/comments/${commentId}?secret=${httpReview.review.ownerToken}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: "owner" }),
  });
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(data.status, "resolved");
});

await testAsync("HTTP: PATCH comment (edit)", async () => {
  const c = httpStore.addComment(httpReview.review.id, { author: "reviewer", body: "to edit", anchor: { quote: "Another" } });
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}/comments/${c.id}?secret=${httpReview.review.ownerToken}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "edit", body: "edited via HTTP" }),
  });
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(data.body, "edited via HTTP");
});

await testAsync("HTTP: POST /api/reviews/:id/revisions (publish)", async () => {
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}/revisions?secret=${httpReview.review.ownerToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown: "# API Test v2\n\nUpdated.\n" }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.review.currentRevisionId, "v2");
});

await testAsync("HTTP: reviewer cannot publish → 403", async () => {
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}/revisions?secret=${httpReview.review.shareSecret}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown: "# fail\n" }),
  });
  assert.equal(res.status, 403);
});

await testAsync("HTTP: reviewer cannot resolve → 403", async () => {
  const c = httpStore.addComment(httpReview.review.id, { author: "reviewer", body: "x", anchor: { quote: "Updated" } });
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}/comments/${c.id}?secret=${httpReview.review.shareSecret}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: "reviewer" }),
  });
  assert.equal(res.status, 403);
});

await testAsync("HTTP: POST /api/agent/comments", async () => {
  const session = httpStore.createAgentSession(httpReview.review.id, { author: "http-agent" });
  const res = await fetch(`${origin}/api/agent/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: session.token, body: "Agent via HTTP", anchor: { quote: "Updated." } }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.authorType, "agent");
});

await testAsync("HTTP: POST /api/agent/resolve", async () => {
  const session = httpStore.createAgentSession(httpReview.review.id, { author: "resolve-agent" });
  const comments = httpStore.authorizeReview(httpReview.review.id, httpReview.review.ownerToken).payload.comments;
  const openComment = comments.find((c) => c.status === "open");
  const res = await fetch(`${origin}/api/agent/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: session.token, commentId: openComment.id }),
  });
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(data.status, "resolved");
});

await testAsync("HTTP: GET /api/reviews/:id/history", async () => {
  const res = await fetch(`${origin}/api/reviews/${httpReview.review.id}/history?secret=${httpReview.review.ownerToken}`);
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.ok(data.diff.rows.length > 0);
});

server.close();

// ============================================================
// Part 13: Edge cases — quote at boundaries
// ============================================================

test("locateQuote: quote at offset 0 with empty before", () => {
  const md = "Start of document. More text. Start of document.";
  const loc = locateQuote(md, { quote: "Start of document.", before: "", after: " More text." });
  assert.ok(loc);
  assert.equal(loc.start, 0);
});

test("locateQuote: overlapping potential matches", () => {
  const md = "aa aa aa";
  const loc = locateQuote(md, { quote: "aa" });
  // First occurrence
  assert.equal(loc.start, 0);
});

test("extractContext + locateQuote roundtrip", () => {
  const md = "Duplicate. Middle content here. Duplicate. End content.";
  // Extract context for the second "Duplicate."
  const secondIdx = md.lastIndexOf("Duplicate.");
  const before = md.slice(Math.max(0, secondIdx - 200), secondIdx);
  const after = md.slice(secondIdx + "Duplicate.".length, secondIdx + "Duplicate.".length + 200);
  const loc = locateQuote(md, { quote: "Duplicate.", before, after });
  assert.equal(loc.start, secondIdx);
});

// ============================================================
// Summary
// ============================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
