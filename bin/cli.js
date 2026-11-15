#!/usr/bin/env node
// zcode-acp CLI 入口（npm 形态薄壳，命令分发逻辑在 src/cli.js，
// 与单文件 exe 形态共用）。
import { runCli } from "../src/cli.js";

await runCli(process.argv);
