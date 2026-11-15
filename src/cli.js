// CLI 命令分发：bin/cli.js（npm 形态）与 build/sea-entry.js（单文件 exe 形态）
// 共用的入口，保证两种形态行为一致。
import { AGENT_INFO, startAgent } from "./agent.js";
import { startClaude } from "./claude.js";
import { execLogin, execLoginNoBrowser, execLogout } from "./login.js";
import { runDoctor, runSetup } from "./doctor.js";

function printHelp() {
  console.log(`zcode-acp ${AGENT_INFO.version} — 把 ZCode CLI 包装成 ACP v1 agent

用法：
  zcode-acp                以 ACP stdio 模式启动（供客户端拉起）
  zcode-acp login          登录 ZCode（浏览器授权）
                           --no-browser 只打印授权 URL，不开浏览器
  zcode-acp logout         退出登录
  zcode-acp doctor         安装自检（--probe 实跑一轮验证）
  zcode-acp setup          自检 + 认证导出 + 自动注册到本机 ACP 客户端
                           （OpenIdea / Zed，装了哪个注册哪个）
  zcode-acp -p --input-format stream-json --effort <level>
                           MiCO Claude 兼容入口（low / medium / high）
  zcode-acp --version      输出版本号
`);
}

/**
 * 解析并执行一条 CLI 命令。只设置 process.exitCode，不主动退出进程：
 * login/logout 代理直通终端，子进程退出码由 login.js 透传退出。
 */
export async function runCli(argv) {
  const [command, ...rest] = argv.slice(2);

  if (command === "-p" && rest[rest.indexOf("--input-format") + 1] === "stream-json") {
    await startClaude(argv.slice(2));
    return;
  }

  switch (command) {
    // MiCO 的 qoder 适配器以 --yolo 启动 ACP；bridge 默认就是 yolo，直接复用服务入口。
    case "--yolo":
    case undefined:
    case "serve":
    // acp 是 ACP 生态的约定入口名（opencode/kimi/pool 的 agent server 均以
    // `<cmd> acp` 拉起），等价 serve。
    case "acp":
      startAgent();
      return;
    case "--version":
    case "-v":
      // 裸版本号：部分宿主用它做 preflight 探测，空输出会被判为不可用。
      console.log(AGENT_INFO.version);
      return;
    case "login":
      if (rest.includes("--no-browser")) execLoginNoBrowser();
      else execLogin();
      return;
    case "logout":
      execLogout();
      return;
    case "doctor":
      process.exitCode = (await runDoctor({ probe: rest.includes("--probe") })) ? 0 : 1;
      return;
    case "setup":
      process.exitCode = (await runSetup()) ? 0 : 1;
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`未知命令：${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}
