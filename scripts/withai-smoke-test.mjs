import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { createWithAiServer } from "../src/server/app.mjs";
import { createReviewStore } from "../src/server/store/review-store.mjs";

const root = mkdtempSync(join(tmpdir(), "withai-smoke-"));
const mdPath = join(root, "proposal.md");
const initialMarkdown = `# Product Design

Same quote.

This is **bold text** and \`inline code\` with [a link](https://example.com).

## Background

- Duplicate quote
- Local agents need structured comments.

1. Ordered quote
2. Another ordered item

> Block quote line

\`\`\`js
console.log("Code quote");
\`\`\`

| Col | Value |
| --- | --- |
| Row | Table quote |

Same quote.
`;

writeFileSync(mdPath, initialMarkdown);

const store = createReviewStore({ root });
const payload = store.createReview({ sourcePath: mdPath, author: "owner" });
assert.equal(payload.review.currentRevisionId, "v1");
assert.ok(payload.document.markdown.length > 0);
assert.equal(payload.document.blocks, undefined, "blocks should not exist in document");

// Test comment with just quote
const comment1 = store.addComment(payload.review.id, {
  author: "reviewer",
  authorType: "human",
  body: "Explain why Markdown-native matters.",
  anchor: { quote: "Same quote." },
});
assert.equal(comment1.anchor.quote, "Same quote.");
assert.ok(comment1.anchor.before !== undefined);
assert.ok(comment1.anchor.after !== undefined);

// Test comment with explicit before/after for disambiguation
const comment2 = store.addComment(payload.review.id, {
  author: "reviewer",
  authorType: "human",
  body: "This is the second Same quote at the end.",
  anchor: { quote: "Same quote.", before: "| Row | Table quote |", after: "" },
});
assert.equal(comment2.anchor.quote, "Same quote.");
assert.ok(comment2.anchor.before.includes("Table quote"));

// Test comment on code
const codeComment = store.addComment(payload.review.id, {
  author: "reviewer",
  authorType: "human",
  body: "Code block should stay commentable.",
  anchor: { quote: "Code quote" },
});
assert.ok(codeComment.anchor.before.includes("Block quote line"));

// Test comment on inline markdown
const inlineComment = store.addComment(payload.review.id, {
  author: "reviewer",
  authorType: "human",
  body: "Inline Markdown selection should keep its anchor.",
  anchor: { quote: "bold text" },
});
assert.ok(inlineComment.anchor.quote === "bold text");

// Test comment on list item
const listComment = store.addComment(payload.review.id, {
  author: "reviewer",
  authorType: "human",
  body: "List items should be commentable.",
  anchor: { quote: "Duplicate quote" },
});
assert.ok(listComment.id.startsWith("c_"));

// Verify all comments created
const allComments = store.getReview(payload.review.id);
// getReview returns raw review, we need to check comments separately via the API
const authorized = store.authorizeReview(payload.review.id, payload.review.ownerToken);
assert.equal(authorized.payload.comments.length, 5);

// Test agent session
const session = store.createAgentSession(payload.review.id, { author: "reviewer-agent", server: "http://127.0.0.1:4174" });
assert.ok(session.token.startsWith("agt_"));
assert.ok(session.command);

// Test agent comment (no blockId needed, just quote)
store.addAgentComment({
  token: session.token,
  body: "Agent observed an issue.",
  anchor: { quote: "Local agents need structured comments." },
});
const afterAgent = store.authorizeReview(payload.review.id, payload.review.ownerToken);
assert.equal(afterAgent.payload.comments.length, 6);

// Test resolve
store.resolveComment(payload.review.id, comment1.id, { actor: "owner" });
const afterResolve = store.authorizeReview(payload.review.id, payload.review.ownerToken);
const resolved = afterResolve.payload.comments.find((c) => c.id === comment1.id);
assert.equal(resolved.status, "resolved");

// Test edit
store.editComment(payload.review.id, comment2.id, { body: "Edited body" });
const afterEdit = store.authorizeReview(payload.review.id, payload.review.ownerToken);
const edited = afterEdit.payload.comments.find((c) => c.id === comment2.id);
assert.equal(edited.body, "Edited body");

// Test publish revision — no reanchor, just saves new markdown
const updatedMarkdown = `# Product Design v2

Same quote.

This is updated text with new content.

## Background

- Local agents need structured comments.
- New item added.

Same quote.
`;
writeFileSync(mdPath, updatedMarkdown);
const published = store.publishRevision(payload.review.id, {});
assert.equal(published.review.currentRevisionId, "v2");
assert.equal(published.document.blocks, undefined);

// Verify comments still exist (not deleted by publish)
const afterPublish = store.authorizeReview(payload.review.id, payload.review.ownerToken);
assert.equal(afterPublish.payload.comments.length, 6);

// Test context.json shape — no blocks
const contextPaths = store.writeAgentContext(payload.review.id);
const contextJson = JSON.parse(readFileSync(contextPaths.json, "utf8"));
assert.equal(contextJson.document.blocks, undefined);
assert.ok(contextJson.document.markdown.length > 0);
assert.ok(contextJson.comments.length > 0);
assert.ok(contextJson.comments[0].quote !== undefined);
assert.equal(contextJson.review.ownerToken, undefined);
assert.equal(contextJson.review.shareSecret, undefined);
assert.equal(contextJson.rules.canResolve, true);

// Test agent context
const agentContext = store.getAgentContext(session.token);
assert.equal(agentContext.document.blocks, undefined);
assert.ok(agentContext.document.markdown);
assert.equal(agentContext.review.ownerToken, undefined);
assert.equal(agentContext.session.token, undefined);

// Test token rotation
const rotatedReviewer = store.rotateToken(payload.review.id, "reviewer");
assert.throws(() => store.getPublicReview(payload.review.id, payload.review.shareSecret), /Invalid review secret/);
const rotatedOwner = store.rotateToken(payload.review.id, "owner");
assert.throws(() => store.getPublicReview(payload.review.id, payload.review.ownerToken), /Invalid review secret/);
const freshView = store.getPublicReview(payload.review.id, rotatedOwner.ownerToken);
assert.equal(freshView.review.id, payload.review.id);

// Test agent revocation
store.revokeAgent(payload.review.id, session.id);
assert.throws(() => store.addAgentComment({ token: session.token, body: "fail", anchor: { quote: "x" } }), /Invalid agent token/);

// Test version history
const history = store.buildHistory(payload.review.id);
assert.ok(history.diff.rows.length > 0);

// HTTP server test
const server = createWithAiServer({ root });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

const healthRes = await fetch(`${origin}/health`);
assert.equal(healthRes.ok, true);

const reviewRes = await fetch(`${origin}/api/reviews/${payload.review.id}?secret=${rotatedOwner.ownerToken}`);
assert.equal(reviewRes.ok, true);
const reviewData = await reviewRes.json();
assert.equal(reviewData.document.blocks, undefined);
assert.ok(reviewData.document.markdown);

// POST comment via HTTP
const postRes = await fetch(`${origin}/api/reviews/${payload.review.id}/comments?secret=${rotatedOwner.ownerToken}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ author: "owner", body: "HTTP comment test", anchor: { quote: "Same quote." } }),
});
assert.equal(postRes.status, 201);
const httpComment = await postRes.json();
assert.ok(httpComment.anchor.quote === "Same quote.");
assert.ok(httpComment.anchor.before.length > 0);

// Permission check - reviewer cannot resolve
const newSession = store.createAgentSession(payload.review.id, { author: "test-agent", server: origin });
const reviewerView = store.getPublicReview(payload.review.id, rotatedReviewer.shareSecret);
assert.equal(reviewerView.viewer.canResolve, false);

server.close();
console.log("withai product test passed");
