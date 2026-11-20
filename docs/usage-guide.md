# zcode-acp 使用指南

面向使用者的接入手册：安装、接入 OpenIDEA、验证与排障。
对应 `@luyi0825/zcode-acp` 0.5.6；最后更新：2026-11-17。

zcode-acp 把 [ZCode](https://zcode.z.ai) CLI 包装成 **ACP v1 agent**，让 ACP 客户端把 ZCode 当作自己的编码 agent：

```text
ACP 客户端 ──stdio NDJSON（ACP v1）──▶ zcode-acp ──spawn──▶ zcode CLI（headless）
```

zcode-acp 只做协议翻译；工具、技能、MCP、多轮上下文等 agent 能力全部来自随 ZCode Desktop 发行的 CLI 本体。

## 1. 前置条件

| 项目 | 要求 |
| --- | --- |
| ZCode Desktop | [官网](https://zcode.z.ai) 下载安装。CLI 随其发行（Windows：`<安装目录>\resources\glm\zcode.cjs`；macOS：`<ZCode.app>/Contents/Resources/glm/zcode.cjs`），安装后**不需要打开它** |
| Node.js | ≥ 20（npm 全局安装与 CLI 运行都需要） |
| 自定义安装路径 | 设置环境变量 `ZCODE_HOME` 指向 ZCode 安装目录 |

## 2. 安装

安装包为 npm tarball：`luyi0825-zcode-acp-<版本>.tgz`（维护者用 `npm pack` 打包）。
从 [GitHub Releases](https://github.com/luyi0825/zcode-acp/releases) 下载最新版，
再用 npm 从本地安装：

```bash
npm install -g ./luyi0825-zcode-acp-0.5.6.tgz
zcode-acp --version    # 输出版本号（当前 0.5.6）即安装成功
```

## 3. 登录与认证

推荐**独立登录**（不依赖 ZCode Desktop 运行）：

```bash
zcode-acp login              # 浏览器授权（设备授权码轮询，无本地回调），一次性
zcode-acp login --no-browser # 无桌面环境：只打印授权 URL，不开浏览器
zcode-acp logout             # 退出登录
```

- 凭据存 `~/.zcode/v2/credentials.json`（AES-256-GCM 加密，密钥存 OS keyring）。
- **ZCode Desktop 用户（数据目录被重定向）**：在 Desktop 打开的终端里运行一次 `zcode-acp setup`，把本机布局（`ZCODE_DATA_BASE_DIR`、安装位置等固定值）导出到 `~/.zcode-acp.env`（zcode-acp 启动时默认读取）。**只需跑一次**：这些值不随 Desktop 重启变化，只有换数据目录或换安装位置后才需要重跑。
- 无 OS keyring 的环境（如 Linux 服务器）：先设置 `ZCODE_CREDENTIAL_SECRET`（32–4096 字节的密钥串）再 login。

## 4. 自检

```bash
zcode-acp doctor         # 检查 4 项：Node 版本 / zcode CLI 定位 / 登录态 / 模型列表
zcode-acp doctor --probe # 额外实跑一轮 headless 对话做端到端验证（应返回 PONG）
```

全部通过后再进入接入步骤。未登录时第 3 项会提示 `[warn]`（纯 api-key 配置可忽略），第 4 项「模型列表」依赖登录后生成的 provider 配置。

## 5. 接入 OpenIDEA

### 5.1 手工写入 agent 文件（主流程）

OpenIDEA 会扫描其配置目录下 `agents/` 里的 toml 文件。新建 `zcode.toml`：

```toml
name = "ZCode"
command = 'zcode-acp'
```

`command` 是必填项，`name` 用于在 Agent 选择器中显示；`driver` 默认即 `acp`，`args` 可省略（无参数即 ACP 服务模式），无需额外配置。

各平台文件路径：

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\ai.l0ng.openidea\agents\zcode.toml` |
| macOS | `~/Library/Application Support/ai.l0ng.openidea/agents/zcode.toml` |
| Linux | `~/.config/ai.l0ng.openidea/agents/zcode.toml` |

如果 IDE 环境的 PATH 里找不到 `zcode-acp`，先查出绝对路径，把 `command` 写成绝对路径：

```bash
where zcode-acp        # Windows
command -v zcode-acp   # macOS / Linux
```

官方参考：[agents 配置](https://openidea.sh/zh/guide/agents)、[数据目录](https://openidea.sh/zh/reference/data-directories)。

### 5.2 在 OpenIDEA 里使用

1. 打开并信任一个项目；
2. 右侧「智能体」→「新建 Agent 任务」；
3. Agent 选择 ZCode，按需选择模型与模式，输入任务发送。

保存 toml 后如果列表里没有 ZCode：先重新打开「新建 Agent 任务」页或让窗口重新聚焦；仍不出现就完全退出并重启 OpenIDEA。

### 5.3 关于 `setup` 自动注册

`zcode-acp setup` 会检测本机已装客户端并写入 agent 入口（在 `%APPDATA%` 下检测 OpenIDEA / Zed，Windows 场景）。macOS / Linux 的客户端配置目录与之不同，自动注册不保证命中——以 5.1 的手工路径为主流程，`setup` 仅作便利尝试。

## 6. 模型、思考级别与权限模式

- **模型**：会话建立后客户端可直接选择，真实列表来自 ZCode 的 personal provider config（编码 `provider::model`）。
- **思考级别**：根据当前模型合并 ZCode personal / builtin 规则后显示实际档位，可能包括 `disabled / enabled`、`low / high / max`、`medium / xhigh` 等；切换模型后选项自动刷新，旧档位不兼容时回到新模型默认档位。
- **权限模式**：计划模式（plan）/ 变更前确认（build）/ 自主模式（guarded）/ 完全访问（yolo），映射 ZCode 原生 `--mode`；旧客户端回传的 `edit` 仅作兼容输入，不在选择器中显示。

> **安全提示（必读）**：默认权限模式是 **yolo**——headless 运行没有确认入口，agent 会**无确认地读写文件、执行命令**。只把 zcode-acp 接入你信任的客户端与项目；需要受控执行时在客户端切换 **plan**（只读）或 **guarded**（守卫模式）。

已知行为：模型 / 思考级别 / 模式的选择与会话续接映射落盘在 `~/.zcode-acp-sessions.json`，zcode-acp 重启后由 `session/resume` / `session/load` 自动恢复，续接与选择都不丢；同一会话内多轮续接保持选中项。

### 6.1 验证模型与思考级别生效

```text
%TEMP%\zcode-acp-provider-*.json   # Windows；POSIX 在系统临时目录
```

看副本中的 `modelOrder[0]` 是否为选中模型、`optionSpecs.reasoningLevel.values` 末位是否为选中级别（zcode 取末位为默认级别）。副本来自完整 provider 配置，可能包含敏感信息，不要外发；当前由操作系统清理临时目录，zcode-acp 不主动删除副本。

## 7. 验证清单

| 步骤 | 操作 | 期望结果 |
| --- | --- | --- |
| 安装 | `zcode-acp --version` | 输出版本号 |
| 自检 | `zcode-acp doctor` | 4 项通过（登录态缺失会 `[warn]`） |
| 端到端 | `zcode-acp doctor --probe` | `probe 返回 PONG` |
| OpenIDEA | 新建 Agent 任务选 ZCode，发送「只回复 PONG」 | 会话内收到回复 |

前 3 项在终端执行；OpenIDEA 一行是接入后的验证方式，需在客户端里实际操作确认。

## 8. 常见排障

| 症状 | 处理 |
| --- | --- |
| `401 API Key 不存在` / `invalid_key` | 未登录或认证过期：`zcode-acp login`（Desktop 用户在 Desktop 终端里 `setup`） |
| `找不到 zcode.cjs` | 安装 ZCode Desktop，或设 `ZCODE_HOME` 指向安装目录 |
| 模型列表为空 / 选不了模型 | `zcode-acp doctor` 看第 4 项；通常是未登录（provider 配置未生成） |
| Windows 下客户端拉不起 zcode-acp | `where zcode-acp` 确认命中预期形态（npm 全局 bin 或 `~/.local/bin/zcode-acp.exe`），必要时重开客户端；部分宿主只接受真可执行文件，见 README「开发」一节的单文件 exe |
| OpenIDEA 列表里没有 ZCode | 核对 toml 路径与内容 → 重新打开「新建 Agent 任务」页 / 窗口重新聚焦 → 完全重启 OpenIDEA |
| zcode-acp 重启后上下文 / 选择丢失 | 续接状态已落盘 `~/.zcode-acp-sessions.json` 并自动恢复；若仍丢失，检查该文件是否被删 / 损坏（损坏会降级回内存-only），必要时客户端重发上下文、重选模型 |
| `doctor --probe` 失败 | 看报错尾部提示；含 401 相关字样先重新登录再重试 |

## 9. 其它客户端

Zed 的 `settings.json`：

```json
{ "agent_servers": { "zcode": { "command": "zcode-acp", "args": [] } } }
```

其它 ACP 客户端以 stdio NDJSON 拉起 `zcode-acp`（无参数即 ACP 服务），按 ACP v1 协议交互。协议与实现原理见 [acp-sharing.md](../mydoc/acp-sharing.md)。