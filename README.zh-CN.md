# RecordForge

录制浏览器操作，并**确定性回放**。RecordForge 通过 CDP 挂接到任意 Chromium 系浏览器，捕获你的真实操作（点击、输入、悬停、下拉选择、滚动、文件上传、右键菜单、跳转），编译成确定性回放脚本，再用真实输入事件回放——**回放过程不读页面、不调用 LLM**。

它同时以 **MCP server**（可直接接入 Claude Code、Codex、Hermes、Cline 等）和 **CLI** 两种形态发布。

```
录制  ->  编译  ->  回放
```

<p align="center"><img src="assets/screenshot.png" alt="recordforge 回放表单" width="680"></p>

<p align="center"><img src="assets/demo.gif" alt="recordforge 演示" width="680"></p>

## 为什么是确定性回放？

多数浏览器智能体每走一步都要重新读页面、让模型重新决策——慢、不确定、烧 token。RecordForge 把工作流**录一次**，编译成固定的 `{op, finders, value, wait}` 步骤序列，一次跑完、定位策略固定。每一步要么成功，要么精确停在「第几步 + 原因」，绝不靠猜。

## 特性

- **全动作捕获**：点击、输入、悬停、下拉、滚动、文件上传、右键、回车提交、跳转，覆盖标签页内**所有 frame**（含动态创建的 iframe）。
- **健壮定位器**：每个元素按优先级链定位（稳定 id → class → name → data-testid → placeholder → aria-label → title → label → 可见文字 → 表格列 → 结构路径），并带有序兜底（`text:`、`xpath:`、CSS）。
- **React / Ant Design 感知**：录制时过滤瞬态状态类（`ant-*-open`、`-active`、`-hover`）和带 hash 前缀的动态 id；表单字段走原生 value setter，让受控组件正确感知变更。
- **秘密永不落盘**：`type=password` 及 `autocomplete` 敏感字段（`current-password`、`new-password`、`one-time-code`、`cc-number`、`cc-csc`）只记录 `{SECRET:name}` 占位符——值根本不跨 CDP 边界。回放时才从本地存储解析，绝不写进录制或技能。
- **业务输入全参数化**：每个输入值都变成 `{{name}}` 占位符，回放绝不会照抄你演示时填的具体值。
- **导航后校验**：每次跳转后等下一步目标元素出现，而不是固定延时后盲点。

## 安装

工具是**与智能体无关**的：装一次，所有智能体同一种用法。唯一按智能体区分的，是下面的 MCP 接线和技能落位。

**从 npm**（发布后）：

```bash
npm install -g @anyforgex/recordforge
```

**从源码**：

```bash
git clone https://github.com/anyforge/recordforge recordforge
cd recordforge
./install.sh          # npm install + npm link
```

需要 Node 18+ 和 Chromium 系浏览器（Chrome / Chromium / Edge / Brave）。

## 快速上手（CLI）

```bash
# 1. 录制——自动拉起一个全新 Chrome；做完流程后按 Ctrl-C
recordforge record --name order-status

# 2. 编译成确定性技能
recordforge compile ~/.recordforge/recordings/order-status-<时间戳>.json --name order-status

# 3. 回放，填入参数化变量
recordforge replay ~/.recordforge/skills/order-status.json 金额=800 事由=出差
```

也可以录制你已打开的浏览器：

```bash
# 用远程调试端口启动 Chrome
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/rf-profile

# 录制当前标签页
recordforge record --cdp http://127.0.0.1:9222 --name checkout
```

## MCP 接入

把 recordforge 加为 MCP server，任何支持 MCP 的智能体即可自动发现 `record_start`、`record_stop`、`compile`、`replay`、`list` 及 `secret_*` 工具。`recordforge-mcp` 命令来自 `npm install -g @anyforgex/recordforge`；源码安装用 `node /绝对路径/recordforge/src/index.js`。

**Claude Code**（项目 `.mcp.json` 或 `~/.claude.json`）：

```json
{
  "mcpServers": {
    "recordforge": {
      "command": "recordforge-mcp"
    }
  }
}
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.recordforge]
command = "recordforge-mcp"
```

**Hermes**：`hermes mcp add recordforge -- recordforge-mcp`

之后智能体通过工具走同一流程：`record_start` →（你操作浏览器）→ `record_stop` → `compile` → `replay`。

## 工作原理

| 阶段 | 说明 |
|---|---|
| **录制** | 自包含的捕获脚本经 CDP 注入每个 frame。步骤通过 CDP binding 实时流回宿主，点击引发的跳转不会丢步。 |
| **编译** | 确定性、不调 LLM：归一化步骤、剔除冗余提交、参数化所有输入、秘密路由到存储，产出带有序定位器的回放脚本；同时生成一份 `learn_prompt` 供宿主智能体可选地润色描述与变量名。 |
| **回放** | 脚本经 CDP 一次跑完：每步通过注入的查找器运行时定位元素，派发真实鼠标/键盘事件（表单字段走原生 value setter）。失败即停在「第几步 + 原因」。 |

## 生成可移植的 Agent Skill

编译后，可生成为**通用 Agent Skill**——一份 `SKILL.md`（frontmatter `name` + `description`），任何实现 Agent Skills 规范的智能体都能加载：

```bash
recordforge emit ~/.recordforge/skills/order-status.json --name order-status
```

产物包含 `SKILL.md`（技能）、`skill.json`（回放载荷）、`README.md`（分智能体的安装 + MCP 指引）。

| 智能体 | SKILL.md 安装路径 | MCP 接入 |
|---|---|---|
| Hermes | `~/.hermes/skills/<name>/` | `hermes mcp add recordforge -- recordforge-mcp` |
| Claude Code | `~/.claude/skills/<name>/` 或 `.claude/skills/<name>/` | `.mcp.json` |
| Codex | `~/.codex/config.toml` 里 `[[skills.config]] path=...` | `[mcp_servers.recordforge]` |
| Pi | `~/.pi/agent/skills/<name>/` 或 `.pi/skills/<name>/` | `pi mcp add recordforge -- recordforge-mcp` |
| OpenClaw | `~/.openclaw/workspace/skills/<name>/` | gateway 设置 |
| DeepSeek Harness (dsh) | `dsh/` 里的原生 bundle —— `dsh plugin add ./dsh` | 原生工具 |

## 安装使用技能

仓库自带一份便携的 **「recordforge」使用技能**——[`skill/recordforge/SKILL.md`](skill/recordforge/SKILL.md)——教智能体 recordforge 的用法（record → compile → emit → replay、秘密、MCP）。装进任何实现 Agent Skills 规范的智能体：

| 智能体 | 安装 |
|---|---|
| Claude Code | 拷到 `~/.claude/skills/recordforge/` |
| Codex | `~/.codex/config.toml` 里 `[[skills.config]] path=...` |
| Pi | 拷到 `~/.pi/agent/skills/recordforge/` |
| OpenClaw | 拷到 `~/.openclaw/workspace/skills/recordforge/` |
| Hermes | 拷到 `~/.hermes/skills/recordforge/` |

注意：这与 `recordforge emit` 生成的技能不同——这个是教「怎么用 recordforge」，`emit` 是把「一次录制」变成可回放的技能。

## 秘密

秘密存放在本地（`~/.recordforge/secrets.json`，权限 0600），仅回放时按名解析：

```bash
recordforge secret set password     # 掩码输入
recordforge secret list             # 只列名字，绝不回显值
recordforge secret delete password
```

> **v1 说明**：存储是明文文件、未加密，面向单机。OS 钥匙串后端已在规划。若通过 MCP `secret_set` 把秘密交给智能体，值必然经过 MCP 通道——不希望智能体看到的秘密请用 CLI 掩码输入。

## 定位器模型

每个录制步骤带一个主定位器 + 有序兜底。定位器前缀：

| 前缀 | 含义 |
|---|---|
| `#id` | 元素 id（带 hash 前缀的会话 id 会按其稳定后缀匹配） |
| `css` | CSS 选择器（优先稳定语义 class，而非 `:nth-of-type`） |
| `text:...` | 可见文字 |
| `label:...` | 关联的 `<label>` 文字 |
| `col:...` | 表格列头 |
| `xpath:...` | 带索引的 XPath（iframe 内相对路径） |
| `[name=]`、`[placeholder=]`、`[aria-label=]`、`[title=]` | 属性选择器 |

## 局限

- **多标签页**：已支持——录制与回放覆盖所有标签页，按 URL 切换；两个非当前标签页同 URL 时按首个匹配（有歧义）。
- **iframe**：会录制和回放；跨域 iframe 的点击回退为 JS `click()`（CDP 无法跨域取坐标）。
- **滚动粒度较粗**：窗口滚动按步骤记录、非像素级；嵌套滚动容器内的滚动不捕获。
- **秘密存储为明文**（v2 会加 OS 钥匙串后端）。
- **DeepSeek Harness 插件未实机验证**（developer preview）。

## 开发

```bash
npm test          # 端到端 录制/编译/回放 + MCP 冒烟
node test/e2e.js  # 真实浏览器测试（需 Chrome）
node test/mcp-smoke.js
```

## 许可

AGPL-3.0

## 赞助

如果 recordforge 对你有帮助，欢迎赞助它的开发：

<div align="center">
  <img src="assets/alipay.png" alt="支付宝" width="200" />
  <img src="assets/wechatpay.png" alt="微信支付" width="200" />
</div>
