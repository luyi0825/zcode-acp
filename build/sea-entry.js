// SEA 打包入口：把 ESM bridge 编译成单文件 CJS，供 Node SEA 嵌入。
// 只在构建产物里使用，不参与源码逻辑。
// 与 npm 入口 bin/cli.js 共用 src/cli.js 的分发逻辑，两种形态行为一致。
// 注意本文件不能含顶层 await（esbuild 的 CJS 产物不支持）。
import { runCli } from "../src/cli.js";

runCli(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
