# WithAI Markdown Review

WithAI is a local-first, Markdown-native review surface for people and local agents.

The source of truth is Markdown source, comment anchors, structured comments, and revisions. The web page is review-only: no online body editing, no AI chat window, and no patch preview.

## 中文速览

WithAI 想解决的是本地 Markdown 和在线 review 之间的断点：owner 在本地写 Markdown，生成 reviewer link 和 owner link；reviewer 可以在渲染后的页面上直接评论，也可以让自己的本地 agent 接入 review；owner 的本地 agent 拉取 comments 后修改原始 Markdown，再发布新版本。

它刻意保留 Markdown 作为 source of truth。网页负责阅读、评论、看 diff，不接管正文编辑；comments 锚定到原文 quote 和前后文，agent 读到的是 markdown source + comments，修改的也是本地 markdown。

基本流程：

```text
owner 本地 Markdown
  -> /withai-review proposal.md
  -> 生成 Review link + Owner link
  -> reviewer 读文档 / 写 comments / 接入自己的 agent
  -> owner-agent 拉取 comments，修改本地 Markdown
  -> owner 发布新版本
  -> reviewer 刷新同一个链接看 diff
```

最后一公里也提供了企业微信文档导入：第一次新建，后续覆盖更新。

## Start

Requires Node.js 20+.

Install the local owner command once:

```bash
git clone https://github.com/echoechoher/withai-opensource.git
cd withai-opensource
npm link
```

After that, `withai` works from any terminal directory. It stores review data in this project unless you override `WITHAI_ROOT` or pass `--root`.

```bash
withai start
```

This starts the local server, starts an `ngrok` tunnel, writes `.withai/runtime.json`, and prints active reviews with real owner/reviewer links.

For a stable public review URL, reserve an ngrok domain and start WithAI with that URL:

```bash
withai start --port 4174 --url https://your-domain.ngrok.app
```

or:

```bash
WITHAI_PUBLIC_URL=https://your-domain.ngrok.app withai start --port 4174
```

Or save it once with `configure` and forget about flags:

```bash
withai configure --public-url https://your-domain.ngrok.app --port 4174
withai start
```

Only the owner runs this service. Reviewer does not run WithAI; reviewer only opens the `Review link`. The link stays stable when using a reserved ngrok URL, but it is reachable only while the owner's machine, WithAI, and ngrok are running.

For local-only development:

```bash
withai start --noTunnel --port 4174
```

Then open the local console:

```text
http://127.0.0.1:4174/
```

The browser console shows active reviews without exposing secret links. The owner CLI prints real links because it runs locally on the owner's machine. If you lose a link, recover it from the CLI:

```bash
withai links <review_id>
```

## Create Review Links

In Claude Code, use the skill:

```
/withai-review proposal.md
```

Or use the CLI directly:

```bash
withai review proposal.md --title "Proposal"
```

`withai share` is kept as an alias, but `review` is the recommended user-facing command.

The command prints:

- `Review link`: for reviewer. They can read, comment, and create an agent session.
- `Owner link`: for owner. Owner can publish and resolve.
- `Agent context`: local Markdown/JSON context under `.withai/reviews/<review_id>/`.

Generated state lives in `.withai/reviews/<review_id>/`, and `.withai/` is git ignored.

The owner link is not an online editor. Owner edits the local `.md` file, then publishes a new revision through `watch` or `publish`.

## Daily Review Flow

1. Reviewer opens the review link.
2. Reviewer selects text and writes comments in the right panel.
3. Reviewer can click `Agent review` to copy a bridge command for their local agent.
4. The agent reads Markdown, comments, and rules through the bridge.
5. The agent can write comments and resolve them.
6. Owner edits the local `.md` file.
7. WithAI publishes a new revision through watch or CLI.
8. Reviewer opens version history on the same link.
9. Owner resolves comments manually from the owner link.

Human comment authors are derived from the link type: owner link writes as `owner`; review link writes as `reviewer`.

The root page is a local owner console. It lists active reviews and recovery commands, but it does not expose owner/reviewer/agent secrets through unauthenticated APIs.

## Publish Revisions

Automatic watch:

```bash
withai watch <review_id>
```

Manual publish:

```bash
withai publish <review_id> proposal.md --author owner-agent
```

Version history shows a full-document diff. Comment references appear only when the comment anchor overlaps a changed range; this does not resolve the comment.

## Agent Bridge

The web `Agent review` modal generates a zero-install Node command for reviewer or reviewer-agent.

That command prints an agent-ready task prompt: read the Markdown and write structured comments back to WithAI. The expected behavior is not "return suggestions in chat"; the expected behavior is "create comments in the review page, then summarize what was written."

When `withai start` is running with ngrok, the command uses the public tunnel origin. Without a tunnel, it uses local `127.0.0.1` and only works on the owner's machine.

If reviewer wants their local agent to use files from their own workspace as extra context, they can open that workspace in the agent first, then run the copied command there. The command itself does not install WithAI on their machine.

Read context:

```bash
withai bridge --server <public_origin> --review <review_id> --token <agent_token>
```

Write an agent comment:

```bash
withai bridge --server <public_origin> --review <review_id> --token <agent_token> --quote "这里需要补充原因" --body "建议补充原因说明"
```

Agent rules:

- Agents can read context.
- Agents can write structured comments.
- Agents can resolve comments.
- Agents cannot edit Markdown.
- Agents cannot publish revisions.

## MCP

Run the local MCP server:

```bash
npm run mcp
```

It exposes:

```text
withai://reviews/<review_id>/context.md
withai://reviews/<review_id>/context.json
withai_write_comment
```

Example Codex/Claude Code config:

```json
{
  "mcpServers": {
    "withai": {
      "command": "node",
      "args": ["/absolute/path/to/withai-opensource/src/mcp/withai-mcp.mjs"],
      "env": {
        "WITHAI_ROOT": "/absolute/path/to/your/markdown-workspace"
      }
    }
  }
}
```

## Health And Security

```bash
withai doctor
withai rotate <review_id> --reviewer
withai rotate <review_id> --owner
withai revoke-agent <review_id> <agent_session_id>
```

## Persistent Config

```bash
withai configure --public-url https://your-domain.ngrok.app --port 4174
withai configure --no-tunnel
withai configure            # print current config
withai configure --reset    # delete config
```

Config is saved to `.withai/config.json`. Priority: CLI flags > env vars > config.json > defaults.

## Auto-Start (LaunchAgent)

```bash
withai launch           # install macOS LaunchAgent, auto-start on login
withai launch status    # check daemon PID and server health
withai launch stop      # uninstall LaunchAgent
```

After `withai launch`, the server starts automatically on login, restarts on crash (`KeepAlive`), and logs to `.withai/logs/`. No need to keep a terminal open.

Secret link permissions:

- Owner token: read, comment, publish, resolve.
- Reviewer token: read, comment, create agent session.
- Agent token: read context, write comments.

API responses do not return owner/reviewer/share tokens. Agent context omits owner/reviewer/share tokens.

## Tests

```bash
npm test
```

The tests cover quote-based anchoring, disambiguation with before/after context, comment lifecycle (create, edit, resolve, reopen), revision publishing, version history diffs, permission boundaries, token rotation, agent revocation, HTTP API security, MCP resources, and MCP comment writes.
