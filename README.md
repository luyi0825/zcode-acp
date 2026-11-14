# zcode-acp-bridge

把 [ZCode](https://zcode.z.ai) CLI 包装成 **ACP v1 agent**，让 Zed / OpenIdea / Neovim 等
任意 ACP（Agent Client Protocol）客户端把 ZCode 当作自己的编码 agent 使用。

```
ACP 客户端 ──stdio NDJSON (ACP v1)──▶ zcode-acp-bridge ──spawn──▶ zcode CLI（headless）
```

bridge 只做协议翻译：ZCode 的 agent 能力（工具、skills、MCP、hooks、多轮上下文）
全部来自随 ZCode Desktop 发行的 CLI 本体，bridge 自动定位并驱动它。

## 前置条件

1. **ZCode Desktop**（CLI 的发行载体）：[官网](https://zcode.z.ai) 下载安装。
   安装后**不需要打开它**——CLI 是独立的（`<安装目录>/resources/glm/zcode.cjs`），
   bridge 按标准安装路径自动定位；自定义安装路径时设 `ZCODE_HOME` 指向安装目录即可。
2. **Node ≥ 20**（npm 安装与 CLI 运行都需要）。

## 快速开始

```bash
npm install -g zcode-acp-bridge
zcode-acp-bridge login      # 浏览器授权登录（一次性）
zcode-acp-bridge doctor     # 自检：CLI 定位 / 登录态 / 模型列表
```

`zcode-acp-bridge setup` 可一次完成自检并打印各客户端的接入配置；
`doctor --probe` 会实跑一轮 headless 对话做端到端验证。

## 客户端接入

### Zed

`settings.json`：

```json
{ "agent_servers": { "zcode": { "command": "zcode-acp-bridge", "args": [] } } }
```

### OpenIdea

agent 文件（`<配置目录>/agents/zcode.toml`）：

```toml
name = "ZCode"
command = 'zcode-acp-bridge'
```

### 其它 ACP 客户端

以 stdio NDJSON 拉起 `zcode-acp-bridge`（无参数即 ACP 服务），按 ACP v1 协议交互。

## 认证

两条路径，按你的使用方式选其一：

1. **独立登录（推荐）**：`zcode-acp-bridge login` 走浏览器授权（设备授权码轮询，
   无需本地回调），凭据存 `~/.zcode/v2/credentials.json`（AES-256-GCM 加密，
   密钥在 OS keyring）。全程不依赖 ZCode Desktop 运行。
2. **ZCode Desktop 用户（数据目录被重定向）**：在 Desktop 打开的终端里运行
   `zcode-acp-bridge setup`，自动把 Desktop 签发的运行时变量导出到
   `~/.zcode-acp.env`（bridge 启动时默认读取）。Desktop 重启后这些变量会更换，
   届时重新运行一次 `setup` 即可。

Linux 服务器等无 OS keyring 的环境：设置 `ZCODE_CREDENTIAL_SECRET` 环境变量
（32–4096 字节的密钥串）后 login。

## 模型选择与思考级别

bridge 在 `session/new` / `session/load` / `session/resume` 里报告真实模型列表
（来自 ZCode 的 personal provider 配置，按 providerOrder × modelOrder 展开）与
思考级别选项（`configOptions` 的 `reasoning`：low / high / max），客户端的模型
选择器、思考级别选择器直接可用。

实现背景（实测逆向 zcode CLI 得出）：headless（`-p`）模式没有切换模型/思考级别的
参数，其默认模型取 provider 配置里 `providerOrder[0]` 的 `modelOrder[0]`，默认
思考级别取该模型 `optionSpecs.reasoningLevel.values` 的末位。因此 `session/set_model`
与 `session/set_config_option` 的实现是：生成一份把选中项重排到位的**一次性
provider 配置副本**（临时目录，随机文件名）喂给子进程——认证不受影响。

已知限制：选择存在 bridge 进程内存里，bridge 重启后回到默认值，客户端重选一次即可；
同一会话内多轮续接（`--resume`）保持选中项。

## 工作方式

- 每轮 prompt 独立 spawn `zcode -p --output-format stream-json --mode yolo`，
  多轮上下文由 `--resume <sessionId>` 续接；
- 提示词以 `--prompt=<text>` 等号形式传入，客户端输入不可能被解析成 CLI 选项；
- **权限模式为 yolo**：客户端下发的任务会无确认读写文件、执行命令，
  只接入你信任的客户端；
- stream-json 事件翻译为 ACP 更新：文本/推理增量、工具调用与结果、token 用量。

## 排障

| 症状 | 处理 |
| --- | --- |
| `401 API Key 不存在` | 未登录或认证过期：`zcode-acp-bridge login`（Desktop 用户：在 Desktop 终端里 `setup`） |
| `找不到 zcode.cjs` | 安装 ZCode Desktop，或设 `ZCODE_HOME` 指向安装目录 |
| 模型列表为空 / 选不了模型 | `zcode-acp-bridge doctor` 看第 4 项；通常是未登录（provider 配置未生成） |
| Windows 下客户端拉不起 | 确认 `where zcode-acp-bridge` 能命中 npm 全局 bin，必要时重开客户端 |

## 开发

```bash
npm install
npm run smoke          # 24 项协议自测（需要本机已登录 zcode）
```

可选：构建不依赖 Node 的单文件可执行程序（部分宿主只接受真 .exe）：

```bash
bash build/build-exe.sh   # 产出 build/zcode-acp-bridge.exe
```

## 许可证

[MIT](LICENSE)
