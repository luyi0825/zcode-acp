# zcode-acp 当前限制

对应 `@luyi0825/zcode-acp` 0.5.6；最后更新：2026-11-19。
（本文自分享文档 `mydoc/acp-sharing.md` 移出，作为独立参考。）

- **不重放历史**：会话续接状态已落盘并自动恢复，但消息历史不持久化，由客户端自行处理；
- **临时 provider 副本由 OS 清理**：留在系统临时目录，zcode-acp 不主动删除；
- **默认 yolo 与 cwd 信任边界**：安全依赖「只接入信任的客户端 / 项目」这一使用约定；
- **Claude 兼容层是最小实现**：只覆盖 Mutica 实际下发的单轮消息、模型 / 命令发现、
  `--resume` 与 interrupt，不是完整 Claude Code 流式协议；
- **多媒体与 ACP MCP 透传未支持**：`promptCapabilities` 仅 image；不接收客户端通过
  ACP 下发的 HTTP / SSE MCP 配置，但 ZCode CLI 自身配置的 MCP 不受影响；
- **仅 stdio**：远程 HTTP / WebSocket 传输未实现；
- **模型列表降级**：读不到 personal provider config 时回退单模型声明，保链路不断；
- **Mutica 各 protocol family 的入口差异**（acp 族执行器未接入、qoder / kimi 族无
  思考档位，推荐 claude 族）是 Mutica 0.6.216 的版本行为，不是 ACP 协议本身的限制。
