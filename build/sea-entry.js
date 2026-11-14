// SEA 打包入口：把 ESM bridge 编译成单文件 CJS，供 Node SEA 嵌入。
// 只在构建产物里使用，不参与源码逻辑。
import { startAgent } from "../src/agent.js";

startAgent();
