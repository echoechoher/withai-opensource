# WithAI Markdown Review

<p align="right">
  <a href="#english">English</a> | <a href="#中文">中文</a>
</p>

## English

WithAI is a local-first, Markdown-native review surface for people and local agents.

It keeps Markdown as the source of truth. The web page is only for reading, commenting, and viewing diffs; it does not become the editor for the document body. Comments are anchored to the original quote and nearby context, so an agent can read `markdown source + comments` and update the local `.md` file.

### What It Does

```text
owner local Markdown
  -> withai review proposal.md
  -> Review link + Owner link
  -> reviewer reads / comments / connects their own agent
  -> owner-agent reads comments and edits local Markdown
  -> owner publishes a new revision
  -> reviewer refreshes the same link and checks the diff
```

### Install

Requires Node.js 20+.

```bash
git clone https://github.com/echoechoher/withai-opensource.git
cd withai-opensource
npm link
```

After `npm link`, the `withai` command is available from any terminal directory.

`WITHAI_ROOT` only controls where review state, runtime config, and local context files are stored. It does not need to point to this package's install directory.

### Start The Server

For local-only use:

```bash
withai start --noTunnel --port 4174
```

Open:

```text
http://127.0.0.1:4174/
```

For a public review link, install and log in to `ngrok`, then run:

```bash
withai start
```

For a stable public URL:

```bash
withai configure --public-url https://your-domain.ngrok.app --port 4174
withai start
```

Only the owner needs to run WithAI. Reviewers open the `Review link`. Public links are reachable only while the owner's machine, WithAI server, and ngrok tunnel are running.

### Create A Review

From the folder containing your Markdown file:

```bash
withai review proposal.md --title "Proposal"
```

The command prints:

- `Review link`: for reviewers. They can read, comment, and create an agent session.
- `Owner link`: for the owner. The owner can publish new revisions and resolve comments.
- `Agent context`: local context files under `.withai/reviews/<review_id>/`.

If you lose the links:

```bash
withai links <review_id>
```

### Local Smoke Test

Use two terminals.

Terminal A:

```bash
withai start --noTunnel --port 4174
```

Terminal B:

```bash
mkdir -p /tmp/withai-demo
cd /tmp/withai-demo
printf '# Proposal\n\nThis line needs review.\n' > proposal.md
withai review proposal.md --title "Proposal"
```

Open the printed `Review link` or `Owner link`. If you create a review before starting the server, WithAI will warn you, but the review is still created and the link will work after the server starts.

### Publish Updates

After editing the local Markdown file, publish a new revision:

```bash
withai publish <review_id> proposal.md --author owner-agent
```

Or watch the source file and publish automatically:

```bash
withai watch <review_id>
```

The same review link will show version history and a full-document diff.

### Agent Bridge

The web `Agent review` modal generates a zero-install Node command for a reviewer agent.

You can create an agent session from the web modal, or through the HTTP API:

```bash
curl -X POST '<server>/api/reviews/<review_id>/agent-sessions?secret=<reviewer_secret>' \
  -H 'content-type: application/json' \
  --data '{"author":"reviewer-agent"}'
```

The response contains the `token` used by `withai bridge`.

Read context:

```bash
withai bridge --server <public_origin> --review <review_id> --token <agent_token>
```

Write an agent comment:

```bash
withai bridge --server <public_origin> --review <review_id> --token <agent_token> --quote "text to comment on" --body "comment body"
```

Agent permissions:

- Agents can read context.
- Agents can write structured comments.
- Agents can resolve comments.
- Agents cannot edit Markdown directly.
- Agents cannot publish revisions.

### MCP

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

Example config:

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

### Optional: Push To WeCom Docs

The owner page includes a WeCom Docs push button. It creates a document the first time and overwrites the same document on later pushes.

This requires `wecom-cli` to be installed and authorized on the owner's machine.

### Health And Config

```bash
withai doctor
withai rotate <review_id> --reviewer
withai rotate <review_id> --owner
withai revoke-agent <review_id> <agent_session_id>
withai configure            # print current config
withai configure --reset    # delete config
```

Config is saved to `.withai/config.json`. Priority: CLI flags > env vars > config.json > defaults.

### Tests

```bash
npm test
```

The tests cover quote anchoring, comment lifecycle, revision publishing, version history diffs, permission boundaries, token rotation, agent revocation, HTTP API security, MCP resources, and MCP comment writes.

## 中文

WithAI 是一个本地优先、Markdown 原生的 review 工具。它主要解决本地 Markdown 和在线 comments 之间的断点。

它保留 Markdown 作为 source of truth。网页只负责阅读、评论、看 diff，不接管正文编辑；comments 会锚定到原文 quote 和前后文，所以 agent 读到的是 `markdown source + comments`，修改的也是本地 `.md` 文件。

### 它解决什么

```text
owner 本地 Markdown
  -> withai review proposal.md
  -> 生成 Review link + Owner link
  -> reviewer 读文档 / 写 comments / 接入自己的 agent
  -> owner-agent 拉取 comments，修改本地 Markdown
  -> owner 发布新版本
  -> reviewer 刷新同一个链接看 diff
```

### 安装

需要 Node.js 20+。

```bash
git clone https://github.com/echoechoher/withai-opensource.git
cd withai-opensource
npm link
```

执行 `npm link` 后，任何终端目录里都可以使用 `withai` 命令。

`WITHAI_ROOT` 只控制 review state、runtime config 和本地 context 文件的存放位置，不需要指向 WithAI 这个 package 的安装目录。

### 启动服务

只在本地使用：

```bash
withai start --noTunnel --port 4174
```

打开：

```text
http://127.0.0.1:4174/
```

如果想生成公网 review link，需要先安装并登录 `ngrok`，然后运行：

```bash
withai start
```

如果想使用稳定公网 URL：

```bash
withai configure --public-url https://your-domain.ngrok.app --port 4174
withai start
```

只有 owner 需要运行 WithAI。reviewer 只需要打开 `Review link`。公网链接能访问的前提是 owner 的电脑、WithAI 服务和 ngrok tunnel 都在运行。

### 创建 Review

在你的 Markdown 文件所在目录运行：

```bash
withai review proposal.md --title "Proposal"
```

命令会输出：

- `Review link`：给 reviewer，用来阅读、评论、创建 agent session。
- `Owner link`：owner 自己保留，用来发布新版本、resolve comments。
- `Agent context`：本地上下文文件，位于 `.withai/reviews/<review_id>/`。

如果链接丢了：

```bash
withai links <review_id>
```

### 本地快速验收

使用两个终端。

终端 A：

```bash
withai start --noTunnel --port 4174
```

终端 B：

```bash
mkdir -p /tmp/withai-demo
cd /tmp/withai-demo
printf '# Proposal\n\nThis line needs review.\n' > proposal.md
withai review proposal.md --title "Proposal"
```

打开命令输出的 `Review link` 或 `Owner link`。如果你先创建 review、后启动 server，WithAI 会提示 server 当前不可访问，但 review 仍然会创建；server 启动后链接就能打开。

### 发布更新

修改本地 Markdown 后，手动发布新版本：

```bash
withai publish <review_id> proposal.md --author owner-agent
```

也可以监听源文件，自动发布：

```bash
withai watch <review_id>
```

reviewer 刷新同一个链接，就能看到 version history 和全文 diff。

### Agent Bridge

网页里的 `Agent review` 会生成一条零安装 Node 命令，给 reviewer 的本地 agent 使用。

你可以从网页弹窗创建 agent session，也可以用 HTTP API 创建：

```bash
curl -X POST '<server>/api/reviews/<review_id>/agent-sessions?secret=<reviewer_secret>' \
  -H 'content-type: application/json' \
  --data '{"author":"reviewer-agent"}'
```

返回结果里的 `token` 会用于 `withai bridge`。

读取上下文：

```bash
withai bridge --server <public_origin> --review <review_id> --token <agent_token>
```

写入 agent comment：

```bash
withai bridge --server <public_origin> --review <review_id> --token <agent_token> --quote "要评论的原文" --body "评论内容"
```

Agent 权限：

- 可以读取上下文；
- 可以写 structured comments；
- 可以 resolve comments；
- 不能直接编辑 Markdown；
- 不能发布新版本。

### MCP

启动本地 MCP server：

```bash
npm run mcp
```

它暴露：

```text
withai://reviews/<review_id>/context.md
withai://reviews/<review_id>/context.json
withai_write_comment
```

配置示例：

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

### 可选：导入企业微信文档

owner 页面提供企业微信文档导入按钮。第一次会新建文档，后续会覆盖更新同一个文档。

这个能力依赖 owner 本机安装并授权 `wecom-cli`。

### 健康检查和配置

```bash
withai doctor
withai rotate <review_id> --reviewer
withai rotate <review_id> --owner
withai revoke-agent <review_id> <agent_session_id>
withai configure            # 查看当前配置
withai configure --reset    # 删除配置
```

配置保存在 `.withai/config.json`。优先级是：CLI flags > env vars > config.json > defaults。

### 测试

```bash
npm test
```

测试覆盖 quote anchoring、comments 生命周期、revision 发布、version history diff、权限边界、token rotation、agent revocation、HTTP API security、MCP resources 和 MCP comment writes。
