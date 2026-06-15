const state = {
  reviewId: null,
  secret: null,
  payload: null,
  selection: null,
  focusedCommentId: null,
  showArchive: false,
};

const els = {
  home: document.getElementById("home-view"),
  homeReviewList: document.getElementById("home-review-list"),
  loading: document.getElementById("loading-view"),
  error: document.getElementById("error-view"),
  errorMessage: document.getElementById("error-message"),
  review: document.getElementById("review-view"),
  reviewActions: document.getElementById("review-actions"),
  document: document.getElementById("document"),
  comments: document.getElementById("comments-list"),
  count: document.getElementById("comment-count"),
  panelTitle: document.getElementById("panel-title"),
  ownerNote: document.getElementById("owner-note"),
  composer: document.getElementById("composer"),
  commentBody: document.getElementById("comment-body"),
  toolbar: document.getElementById("selection-toolbar"),
  archive: document.getElementById("archive-toggle"),
  agentButton: document.getElementById("agent-button"),
  historyButton: document.getElementById("history-button"),
  pushWecomButton: document.getElementById("push-wecom-button"),
  agentModal: document.getElementById("agent-modal"),
  historyModal: document.getElementById("history-modal"),
  agentCommand: document.getElementById("agent-command"),
  agentOriginNote: document.getElementById("agent-origin-note"),
  copyAgentCommand: document.getElementById("copy-agent-command"),
  versionList: document.getElementById("version-list"),
  diffPanel: document.getElementById("diff-panel"),
  toast: document.getElementById("toast"),
};

init().catch(showError);

async function init() {
  const match = location.pathname.match(/^\/r\/([^/]+)\/([^/]+)$/);
  if (!match) {
    els.loading.hidden = true;
    setReviewActionsVisible(false);
    await renderHome();
    els.home.hidden = false;
    return;
  }
  state.reviewId = match[1];
  state.secret = match[2];
  await loadReview();
  els.loading.hidden = true;
  setReviewActionsVisible(true);
  els.review.hidden = false;
  bindEvents();
}

async function renderHome() {
  try {
    const reviews = await api("/api/reviews");
    els.homeReviewList.innerHTML = "";
    if (!reviews.length) {
      els.homeReviewList.innerHTML = `<p class="meta">No reviews yet.</p>`;
      return;
    }
    for (const review of reviews) {
      const item = document.createElement("div");
      item.className = "home-review";
      item.innerHTML = `
        <div>
          <strong>${escapeHtml(review.title)}</strong>
          <p class="meta">${escapeHtml(review.id)} · ${escapeHtml(review.currentRevisionId)}</p>
        </div>
        <code>withai links ${escapeHtml(review.id)}</code>
      `;
      els.homeReviewList.appendChild(item);
    }
  } catch {
    els.homeReviewList.innerHTML = `<p class="meta">Could not load local reviews. Check that the WithAI server is running.</p>`;
  }
}

async function loadReview() {
  state.payload = await api(`/api/reviews/${state.reviewId}`);
  document.title = `${state.payload.review.title} - WithAI`;
  renderOwnerNote();
  renderDocument();
  renderComments();
}

function bindEvents() {
  let selectionTimer = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = readSelection();
      if (!selection || els.composer.hidden === false) {
        hideToolbar();
        return;
      }
      showToolbar(selection);
    }, 50);
  });

  document.getElementById("comment-selection").addEventListener("click", () => {
    const selection = readSelection();
    if (selection) openComposer(selection);
  });

  document.getElementById("cancel-comment").addEventListener("click", () => {
    closeComposer();
  });

  // Click outside composer to close (if empty)
  document.addEventListener("mousedown", (event) => {
    if (els.composer.hidden) return;
    if (els.composer.contains(event.target)) return;
    if (!els.commentBody.value.trim()) closeComposer();
  });

  // Click on document area unfocuses the active comment
  els.document.addEventListener("mousedown", () => {
    unfocusComment();
  });

  els.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitComment();
  });

  els.commentBody.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      await submitComment();
    }
    if (event.key === "Escape") {
      closeComposer();
    }
  });

  els.comments.addEventListener("click", async (event) => {
    // Ignore clicks inside edit mode (textarea, buttons)
    if (event.target.closest(".edit-textarea, .edit-actions")) return;

    const action = event.target.closest("[data-action]");
    if (!action) return;
    const card = action.closest("[data-comment-id]");
    const comment = state.payload.comments.find((item) => item.id === card.dataset.commentId);
    if (!comment) return;

    if (action.dataset.action === "toggle-menu") {
      event.stopPropagation();
      closeAllMenus();
      const dropdown = action.closest(".comment-menu").querySelector(".menu-dropdown");
      dropdown.hidden = !dropdown.hidden;
      return;
    }
    if (action.dataset.action === "focus") focusComment(comment);
    if (action.dataset.action === "resolve") { closeAllMenus(); await resolveComment(comment.id); }
    if (action.dataset.action === "edit") { closeAllMenus(); startEditComment(card, comment); }
  });

  document.addEventListener("click", () => closeAllMenus());

  els.archive.addEventListener("click", () => {
    state.showArchive = !state.showArchive;
    els.archive.textContent = state.showArchive ? "Open" : "Archive";
    renderComments();
  });

  els.agentButton.addEventListener("click", openAgentModal);
  els.copyAgentCommand.addEventListener("click", copyAgentCommand);
  els.historyButton.addEventListener("click", openHistoryModal);
  els.pushWecomButton.addEventListener("click", pushToWecom);
}

function renderDocument() {
  const { document: doc, comments } = state.payload;
  els.document.innerHTML = "";
  const blocks = parseMarkdownForRender(doc.markdown);
  for (const block of blocks) {
    const node = createBlockNode(block);
    node.classList.add("block");
    els.document.appendChild(node);
  }
  markCommentQuotes(comments);
}

function parseMarkdownForRender(markdown) {
  const lines = String(markdown).split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }

    // Thematic break — before list (since `---` starts with `-`)
    if (/^(?:---+|___+|\*\*\*+)\s*$/.test(lines[i])) {
      blocks.push({ type: "hr", text: lines[i] });
      i++;
      continue;
    }

    if (/^#{1,6}\s+/.test(lines[i])) {
      blocks.push({ type: "heading", text: lines[i] });
      i++;
      continue;
    }

    if (/^```/.test(lines[i])) {
      const start = i;
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) i++;
      if (i < lines.length) i++;
      blocks.push({ type: "code", text: lines.slice(start, i).join("\n") });
      continue;
    }

    if (/^>\s?/.test(lines[i])) {
      const start = i;
      while (i < lines.length && /^>\s?/.test(lines[i])) i++;
      blocks.push({ type: "blockquote", text: lines.slice(start, i).join("\n") });
      continue;
    }

    if (/^\|/.test(lines[i])) {
      const start = i;
      while (i < lines.length && /^\|/.test(lines[i])) i++;
      blocks.push({ type: "table", text: lines.slice(start, i).join("\n") });
      continue;
    }

    if (/^\s*(?:[-*]\s|\d+[.)]\s)/.test(lines[i])) {
      const start = i;
      while (i < lines.length) {
        if (/^\s*(?:[-*]\s|\d+[.)]\s)/.test(lines[i])) { i++; continue; }
        if (/^\s{2,}/.test(lines[i]) && lines[i].trim()) { i++; continue; }
        if (!lines[i].trim()) {
          let peek = i + 1;
          while (peek < lines.length && !lines[peek].trim()) peek++;
          if (peek < lines.length && /^\s*(?:[-*]\s|\d+[.)]\s)/.test(lines[peek])) { i++; continue; }
        }
        break;
      }
      blocks.push({ type: "list", text: lines.slice(start, i).join("\n") });
      continue;
    }

    // Paragraph (default)
    const start = i;
    while (i < lines.length && lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\|/.test(lines[i]) &&
      !/^\s*(?:[-*]\s|\d+[.)]\s)/.test(lines[i]) &&
      !/^(?:---+|___+|\*\*\*+)\s*$/.test(lines[i])) {
      i++;
    }
    blocks.push({ type: "paragraph", text: lines.slice(start, i).join("\n") });
  }

  return blocks;
}

function createBlockNode(block) {
  if (block.type === "heading") {
    const level = Math.min(Number(block.text.match(/^(#+)/)?.[1]?.length || 1), 2);
    const node = document.createElement(`h${level}`);
    node.className = `block-heading level-${level}`;
    renderInlineMarkdown(node, block.text.replace(/^#{1,6}\s+/, ""));
    return node;
  }
  if (block.type === "code") {
    const node = document.createElement("pre");
    node.className = "block-code";
    node.textContent = block.text.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
    return node;
  }
  if (block.type === "list") {
    const ordered = /^\s*\d+[.)]\s+/.test(block.text);
    const node = document.createElement(ordered ? "ol" : "ul");
    node.className = "block-list";
    for (const line of block.text.split("\n")) {
      const item = document.createElement("li");
      renderInlineMarkdown(item, line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""));
      node.appendChild(item);
    }
    return node;
  }
  if (block.type === "blockquote") {
    const node = document.createElement("blockquote");
    node.className = "block-blockquote";
    for (const [index, line] of block.text.split("\n").entries()) {
      if (index) node.appendChild(document.createElement("br"));
      renderInlineMarkdown(node, line.replace(/^\s*>\s?/, ""));
    }
    return node;
  }
  if (block.type === "table") {
    return createTableNode(block);
  }
  if (block.type === "hr") {
    return document.createElement("hr");
  }
  const node = document.createElement("p");
  node.className = "block-paragraph";
  renderInlineMarkdown(node, block.text.replace(/\n/g, " "));
  return node;
}

function renderComments() {
  const comments = state.payload.comments.filter((comment) => state.showArchive ? comment.status === "resolved" : comment.status === "open" || comment.status === "orphaned");
  const openCount = state.payload.comments.filter((comment) => comment.status === "open" || comment.status === "orphaned").length;
  els.panelTitle.textContent = state.showArchive ? "Archived comments" : "Open comments";
  els.count.textContent = state.showArchive ? `${comments.length} resolved` : `${openCount} open`;
  els.comments.innerHTML = "";

  for (const comment of comments) {
    const isRelated = state.focusedCommentId === comment.id;
    const card = document.createElement("section");
    card.className = "comment-card";
    card.dataset.commentId = comment.id;
    card.dataset.action = "focus";
    card.tabIndex = 0;
    if (state.focusedCommentId && !isRelated) card.classList.add("dim");
    if (isRelated) card.classList.add("active");

    const head = document.createElement("div");
    head.className = "comment-head";
    const author = document.createElement("span");
    author.className = "comment-author";
    if (comment.authorType === "agent") author.innerHTML = `<span class="agent-dot"></span>`;
    author.append(document.createTextNode(comment.author));
    head.append(author);

    if (comment.status !== "resolved" && state.payload.viewer?.canResolve) {
      const menu = document.createElement("div");
      menu.className = "comment-menu";
      const trigger = document.createElement("button");
      trigger.className = "text-button menu-trigger";
      trigger.type = "button";
      trigger.textContent = "⋯";
      trigger.dataset.action = "toggle-menu";
      const dropdown = document.createElement("div");
      dropdown.className = "menu-dropdown";
      dropdown.hidden = true;
      const resolveItem = document.createElement("button");
      resolveItem.className = "menu-item";
      resolveItem.dataset.action = "resolve";
      resolveItem.type = "button";
      resolveItem.textContent = "Resolve";
      const editItem = document.createElement("button");
      editItem.className = "menu-item";
      editItem.dataset.action = "edit";
      editItem.type = "button";
      editItem.textContent = "Edit";
      dropdown.append(resolveItem, editItem);
      menu.append(trigger, dropdown);
      head.append(menu);
    } else {
      const status = document.createElement("span");
      status.textContent = comment.status === "resolved" ? "resolved" : "";
      head.append(status);
    }

    const body = document.createElement("div");
    body.className = "comment-body";
    body.textContent = comment.body;

    card.append(head, body);
    els.comments.appendChild(card);
  }
}

function renderOwnerNote() {
  if (state.payload.viewer?.role !== "owner") {
    els.ownerNote.hidden = true;
    els.pushWecomButton.hidden = true;
    return;
  }
  const source = state.payload.document.sourcePath || "the local Markdown file";
  els.ownerNote.textContent = `Owner: edit ${source}, then run watch or publish. This page stays review-only.`;
  els.ownerNote.hidden = false;
  els.pushWecomButton.hidden = false;
}

function readSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!els.document.contains(range.commonAncestorContainer)) return null;
  const quote = selection.toString().replace(/\s+/g, " ").trim();
  if (!quote) return null;

  // Capture before/after context from the full document text
  const fullText = els.document.textContent;
  const quotePos = findQuotePositionFromRange(range);
  const before = fullText.slice(Math.max(0, quotePos - 200), quotePos).trim();
  const after = fullText.slice(quotePos + quote.length, quotePos + quote.length + 200).trim();

  return { quote, before, after, rect: range.getBoundingClientRect() };
}

function findQuotePositionFromRange(range) {
  // Walk text nodes to find the character offset of the range start within #document
  const walker = document.createTreeWalker(els.document, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === range.startContainer) return offset + range.startOffset;
    offset += node.textContent.length;
    node = walker.nextNode();
  }
  return offset;
}

function showToolbar(selection) {
  els.toolbar.style.left = `${selection.rect.left + selection.rect.width / 2}px`;
  els.toolbar.style.top = `${Math.max(8, selection.rect.top - 40)}px`;
  els.toolbar.style.transform = "translateX(-50%)";
  els.toolbar.hidden = false;
}

function hideToolbar() {
  els.toolbar.hidden = true;
}

function openComposer(selection) {
  state.selection = selection;
  state.focusedCommentId = null;
  els.composer.hidden = false;
  els.commentBody.value = "";
  hideToolbar();
  renderComments();
  els.commentBody.focus();
}

function closeComposer() {
  state.selection = null;
  els.composer.hidden = true;
  els.commentBody.value = "";
}

async function submitComment() {
  if (!state.selection || !els.commentBody.value.trim()) return;
  await api(`/api/reviews/${state.reviewId}/comments`, {
    method: "POST",
    body: {
      author: currentAuthor(),
      authorType: "human",
      revisionId: state.payload.review.currentRevisionId,
      body: els.commentBody.value.trim(),
      anchor: { quote: state.selection.quote, before: state.selection.before, after: state.selection.after },
    },
  });
  closeComposer();
  await loadReview();
  showToast("Comment saved");
}

async function resolveComment(commentId) {
  await api(`/api/reviews/${state.reviewId}/comments/${commentId}`, {
    method: "PATCH",
    body: { actor: "owner" },
  });
  await loadReview();
  showToast("Comment archived");
}

function closeAllMenus() {
  for (const dropdown of els.comments.querySelectorAll(".menu-dropdown")) {
    dropdown.hidden = true;
  }
}

function startEditComment(card, comment) {
  const body = card.querySelector(".comment-body");
  const textarea = document.createElement("textarea");
  textarea.className = "edit-textarea";
  textarea.value = comment.body;
  textarea.rows = Math.max(3, comment.body.split("\n").length + 1);

  const actions = document.createElement("div");
  actions.className = "edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.className = "toolbar-button primary";
  saveBtn.textContent = "Save";
  saveBtn.type = "button";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "toolbar-button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.type = "button";
  actions.append(saveBtn, cancelBtn);

  body.replaceWith(textarea, actions);
  textarea.focus();

  saveBtn.addEventListener("click", async () => {
    const newBody = textarea.value.trim();
    if (!newBody) return;
    await saveEditComment(comment.id, newBody);
  });
  cancelBtn.addEventListener("click", () => {
    textarea.replaceWith(body);
    actions.remove();
  });
  textarea.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && event.metaKey && !event.isComposing) {
      event.preventDefault();
      const newBody = textarea.value.trim();
      if (!newBody) return;
      await saveEditComment(comment.id, newBody);
    }
    if (event.key === "Escape") {
      textarea.replaceWith(body);
      actions.remove();
    }
  });
}

async function saveEditComment(commentId, body) {
  await api(`/api/reviews/${state.reviewId}/comments/${commentId}`, {
    method: "PATCH",
    body: { action: "edit", body },
  });
  await loadReview();
  showToast("Comment updated");
}

function focusComment(comment) {
  // If already focused on this comment, unfocus it
  if (state.focusedCommentId === comment.id) {
    unfocusComment();
    return;
  }
  state.focusedCommentId = comment.id;
  // Update mark highlights without rebuilding the document DOM
  for (const mark of els.document.querySelectorAll(".comment-mark")) {
    mark.classList.toggle("focused", mark.dataset.commentId === comment.id);
  }
  renderComments();
  const mark = els.document.querySelector(`[data-comment-id="${CSS.escape(comment.id)}"]`);
  if (mark) {
    mark.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function unfocusComment() {
  if (!state.focusedCommentId) return;
  state.focusedCommentId = null;
  for (const mark of els.document.querySelectorAll(".comment-mark")) {
    mark.classList.remove("focused");
  }
  renderComments();
}

async function openAgentModal() {
  const runtime = await fetchRuntime();
  const serverOrigin = runtime?.publicOrigin || location.origin;
  const session = await api(`/api/reviews/${state.reviewId}/agent-sessions`, {
    method: "POST",
    body: { author: "reviewer-agent", server: serverOrigin },
  });
  const readCmd = session.command;
  const writeCmd = session.writeCommand;
  const prompt = session.prompt;
  els.agentCommand.innerHTML = "";

  // Part 1: Prompt (customizable, shown first)
  const section1 = document.createElement("div");
  section1.innerHTML = `<p class="meta" style="margin-bottom:4px"><strong>Prompt (customizable)</strong></p>`;
  const promptArea = document.createElement("textarea");
  promptArea.className = "edit-textarea";
  promptArea.value = prompt;
  promptArea.style.fontSize = "12px";
  promptArea.style.resize = "none";
  promptArea.style.overflow = "hidden";
  promptArea.style.height = "auto";
  const autoResize = () => { promptArea.style.height = "auto"; promptArea.style.height = promptArea.scrollHeight + "px"; };
  promptArea.addEventListener("input", autoResize);
  section1.appendChild(promptArea);

  // Part 2: Read context command
  const section2 = document.createElement("div");
  section2.style.marginTop = "12px";
  section2.innerHTML = `<p class="meta" style="margin-bottom:4px"><strong>Read context</strong></p><code>${escapeHtml(readCmd)}</code>`;

  // Part 3: Write comment command
  const section3 = document.createElement("div");
  section3.style.marginTop = "12px";
  section3.innerHTML = `<p class="meta" style="margin-bottom:4px"><strong>Write comment</strong></p><code>${escapeHtml(writeCmd)}</code>`;

  els.agentCommand.append(section1, section2, section3);
  if (runtime?.hasPublicTunnel) {
    els.agentOriginNote.textContent = `Using public tunnel: ${serverOrigin}`;
  } else {
    els.agentOriginNote.textContent = "Using local server. Run withai start to create a reviewer-accessible tunnel.";
  }
  els.agentModal.showModal();
  // Auto-resize after modal is visible
  requestAnimationFrame(autoResize);
}

async function copyAgentCommand() {
  const pre = els.agentCommand;
  const codes = pre.querySelectorAll("code");
  const textarea = pre.querySelector("textarea");
  const text = [
    "# Prompt",
    textarea?.value || "",
    "",
    "# Read context",
    codes[0]?.textContent || "",
    "",
    "# Write comment",
    codes[1]?.textContent || "",
  ].join("\n");
  await navigator.clipboard.writeText(text);
  showToast("Agent task copied");
}

async function pushToWecom() {
  els.pushWecomButton.classList.add("loading");
  try {
    const result = await api(`/api/reviews/${state.reviewId}/push-wecom`, { method: "POST" });
    if (result.ok && result.url) {
      showToast(`✓ 已推送到企微文档 <a href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer" style="margin-left:6px;color:inherit;font-weight:500">打开 →</a>`, true);
    } else {
      showToast(result.error || "推送失败");
    }
  } catch (error) {
    showToast(error.message || "推送失败");
  } finally {
    els.pushWecomButton.classList.remove("loading");
  }
}

async function openHistoryModal() {
  const history = await api(`/api/reviews/${state.reviewId}/history`);
  renderHistory(history);
  els.historyModal.showModal();
}

function renderHistory(history) {
  els.versionList.innerHTML = "";
  for (const version of history.versions.toReversed()) {
    const row = document.createElement("div");
    row.className = `version-row ${version.id === history.toRevision.id ? "active" : ""}`;
    row.dataset.versionId = version.id;
    row.innerHTML = `<span>${escapeHtml(version.id)}</span><span>${escapeHtml(version.author)}</span>`;
    row.style.cursor = "pointer";
    row.addEventListener("click", async () => {
      const updated = await api(`/api/reviews/${state.reviewId}/history?to=${version.id}`);
      renderHistory(updated);
    });
    els.versionList.appendChild(row);
  }

  els.diffPanel.innerHTML = `<h3>Full document diff · ${escapeHtml(history.fromRevision.id)} -> ${escapeHtml(history.toRevision.id)}</h3>`;
  if (!history.diff.rows.some((row) => row.type !== "context")) {
    const empty = document.createElement("p");
    empty.className = "meta";
    empty.textContent = "No changes between these revisions yet.";
    els.diffPanel.appendChild(empty);
    return;
  }
  for (const row of history.diff.rows) {
    const line = document.createElement("div");
    line.className = `diff-line ${row.type}`;
    line.textContent = `${row.type === "add" ? "+" : row.type === "remove" ? "-" : " "} ${row.text}`;
    els.diffPanel.appendChild(line);
  }
}

async function fetchRuntime() {
  try {
    const response = await fetch("/api/runtime");
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function lineInRange(oldLine, newLine, range) {
  return (
    (oldLine != null && range.oldStart != null && oldLine >= range.oldStart && oldLine <= range.oldEnd) ||
    (newLine != null && range.newStart != null && newLine >= range.newStart && newLine <= range.newEnd)
  );
}

// --- Quote-based highlighting ---

function markCommentQuotes(comments) {
  const visibleComments = comments.filter((comment) => {
    if (state.showArchive) return comment.status === "resolved";
    return comment.status === "open" || comment.status === "orphaned";
  });

  for (const comment of visibleComments) {
    markQuoteInDocument(els.document, comment);
  }
}

function markQuoteInDocument(root, comment) {
  const quote = comment.anchor?.quote;
  if (!quote) return;
  const normalizedQuote = normalizeForSearch(quote);
  if (!normalizedQuote) return;

  const textNodes = collectTextNodes(root);
  const combined = textNodes.map((n) => n.textContent).join("");
  const normalizedCombined = normalizeForSearch(combined);

  // Find all matches
  const matches = [];
  let pos = 0;
  while (true) {
    const idx = normalizedCombined.indexOf(normalizedQuote, pos);
    if (idx === -1) break;
    matches.push(idx);
    pos = idx + 1;
  }
  if (matches.length === 0) return;

  // Disambiguate
  let matchIndex;
  if (matches.length === 1) {
    matchIndex = matches[0];
  } else {
    matchIndex = disambiguateMatch(matches, normalizedCombined, comment.anchor);
  }

  // Map normalized index to original positions and wrap
  const startOriginal = mapNormalizedIndexToOriginal(combined, matchIndex);
  const endOriginal = mapNormalizedIndexToOriginal(combined, matchIndex + normalizedQuote.length);
  const start = locateTextPosition(textNodes, startOriginal);
  const end = locateTextPosition(textNodes, endOriginal);
  if (!start || !end) return;

  wrapTextPieces(textNodes, start, end, comment);
}

function disambiguateMatch(matches, normalizedText, anchor) {
  const before = normalizeForSearch(anchor.before || "");
  const after = normalizeForSearch(anchor.after || "");
  if (!before && !after) return matches[0];

  let bestMatch = matches[0];
  let bestScore = -1;
  const quoteLen = normalizeForSearch(anchor.quote).length;

  for (const matchStart of matches) {
    const precedingText = normalizedText.slice(Math.max(0, matchStart - 200), matchStart);
    const followingText = normalizedText.slice(matchStart + quoteLen, matchStart + quoteLen + 200);
    let score = 0;
    if (before) score += commonSuffixLen(precedingText, before);
    if (after) score += commonPrefixLen(followingText, after);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = matchStart;
    }
  }
  return bestMatch;
}

function commonPrefixLen(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function wrapTextPieces(textNodes, start, end, comment) {
  const startIndex = textNodes.indexOf(start.node);
  const endIndex = textNodes.indexOf(end.node);
  if (startIndex === -1 || endIndex === -1) return;

  const pieces = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const node = textNodes[index];
    const from = index === startIndex ? start.offset : 0;
    const to = index === endIndex ? end.offset : node.textContent.length;
    if (from < to) pieces.push({ node, from, to });
  }

  for (const piece of pieces.toReversed()) {
    const range = document.createRange();
    range.setStart(piece.node, piece.from);
    range.setEnd(piece.node, piece.to);
    const mark = document.createElement("mark");
    mark.className = `comment-mark ${state.focusedCommentId === comment.id ? "focused" : ""}`;
    mark.dataset.commentId = comment.id;
    mark.title = comment.body;
    range.surroundContents(mark);
  }
}

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function normalizeForSearch(value) {
  return String(value || "").replace(/[`*_]/g, "").replace(/\s+/g, "");
}

function mapNormalizedIndexToOriginal(text, targetIndex) {
  let normalizedIndex = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if ("`*_".includes(char) || /\s/.test(char)) continue;
    if (normalizedIndex === targetIndex) return i;
    normalizedIndex += 1;
  }
  return text.length;
}

function locateTextPosition(textNodes, index) {
  let cursor = 0;
  for (const node of textNodes) {
    const next = cursor + node.textContent.length;
    if (index <= next) return { node, offset: Math.max(0, index - cursor) };
    cursor = next;
  }
  const last = textNodes.at(-1);
  return last ? { node: last, offset: last.textContent.length } : null;
}

// --- Utilities ---

async function api(path, options = {}) {
  const url = new URL(path, location.origin);
  url.searchParams.set("secret", state.secret || "");
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function currentAuthor() {
  return state.payload.viewer?.role === "owner" ? "owner" : "reviewer";
}

function showError(error) {
  els.loading.hidden = true;
  els.review.hidden = true;
  els.home.hidden = true;
  setReviewActionsVisible(false);
  els.error.hidden = false;
  els.errorMessage.textContent = error.message || "This review link is invalid or the local server is disconnected.";
}

function setReviewActionsVisible(visible) {
  els.reviewActions.hidden = !visible;
}

function showToast(message, html = false) {
  if (html) {
    els.toast.innerHTML = message;
  } else {
    els.toast.textContent = message;
  }
  els.toast.hidden = false;
  window.setTimeout(() => {
    els.toast.hidden = true;
  }, html ? 4000 : 2200);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInlineMarkdown(parent, text) {
  const tokens = tokenizeInlineMarkdown(text);
  for (const token of tokens) {
    if (token.type === "text") { parent.appendChild(document.createTextNode(token.value)); continue; }
    if (token.type === "code") { const code = document.createElement("code"); code.textContent = token.value; parent.appendChild(code); continue; }
    if (token.type === "strong") { const strong = document.createElement("strong"); renderInlineMarkdown(strong, token.value); parent.appendChild(strong); continue; }
    if (token.type === "em") { const em = document.createElement("em"); renderInlineMarkdown(em, token.value); parent.appendChild(em); continue; }
    if (token.type === "link") { const link = document.createElement("a"); link.href = token.href; link.target = "_blank"; link.rel = "noreferrer"; renderInlineMarkdown(link, token.value); parent.appendChild(link); }
  }
}

function tokenizeInlineMarkdown(text) {
  const pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  const tokens = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) tokens.push({ type: "text", value: text.slice(lastIndex, match.index) });
    if (match[2]) tokens.push({ type: "code", value: match[2] });
    else if (match[4]) tokens.push({ type: "strong", value: match[4] });
    else if (match[6]) tokens.push({ type: "em", value: match[6] });
    else if (match[8]) tokens.push({ type: "link", value: match[8], href: match[9] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) tokens.push({ type: "text", value: text.slice(lastIndex) });
  return tokens;
}

function createTableNode(block) {
  const table = document.createElement("table");
  table.className = "block-table";
  const lines = block.text.split("\n");
  const headers = splitTableRow(lines[0]);
  const bodyLines = lines.slice(2);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of headers) {
    const cell = document.createElement("th");
    renderInlineMarkdown(cell, header);
    headRow.appendChild(cell);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const line of bodyLines) {
    const row = document.createElement("tr");
    for (const value of splitTableRow(line)) {
      const cell = document.createElement("td");
      renderInlineMarkdown(cell, value);
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((value) => value.trim());
}
