// SEA 打包入口：把 ESM bridge 编译成单文件 CJS，供 Node SEA 嵌入。
// 只在构建产物里使用，不参与源码逻辑。
//
// --version 必须在挂接 ACP stdio 之前应答：部分宿主（MiCO 等）派发任务前
// 用 `<exe> --version` 做 preflight，空输出或挂住等 stdin 都会被判不可用。
// 产物形态是"无参数即 ACP 服务"，忽略其余参数（宿主可能追加 acp 等子命令，
// 语义等价 serve）。
import { AGENT_INFO, startAgent } from "../src/agent.js";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`${AGENT_INFO.version}\n`);
  process.exit(0);
}

startAgent();
