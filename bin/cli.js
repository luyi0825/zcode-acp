#!/usr/bin/env node
// zcode-acp-bridge CLI 入口。
//
// 无参数（或 serve）= ACP stdio 服务，供 ACP 客户端拉起；
// 其余子命令供人直接使用：login / logout / doctor / setup。
import { AGENT_INFO, startAgent } from "../src/agent.js";
import { execLogin, execLoginNoBrowser, execLogout } from "../src/login.js";
import { runDoctor, runSetup } from "../src/doctor.js";

function printHelp() {
  console.log(`zcode-acp-bridge ${AGENT_INFO.version} — 把 ZCode CLI 包装成 ACP v1 agent

用法：
  zcode-acp-bridge                以 ACP stdio 模式启动（供客户端拉起）
  zcode-acp-bridge login          登录 ZCode（浏览器授权）
                                 --no-browser 只打印授权 URL，不开浏览器
  zcode-acp-bridge logout         退出登录
  zcode-acp-bridge doctor         安装自检（--probe 实跑一轮验证）
  zcode-acp-bridge setup          自检 + 认证导出 + 自动注册到本机 ACP 客户端
                                 （OpenIdea / Zed，装了哪个注册哪个）
  zcode-acp-bridge --version      输出版本号
`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case undefined:
  case "serve":
  // acp 是 ACP 生态的约定入口名（opencode/kimi/pool 的 agent server 均以
  // `<cmd> acp` 拉起），等价 serve。
  case "acp":
    startAgent();
    break;
  case "--version":
  case "-v":
    // 裸版本号：部分宿主用它做 preflight 探测，空输出会被判为不可用。
    console.log(AGENT_INFO.version);
    break;
  case "login":
    if (rest.includes("--no-browser")) execLoginNoBrowser();
    else execLogin();
    break;
  case "logout":
    execLogout();
    break;
  case "doctor":
    process.exitCode = (await runDoctor({ probe: rest.includes("--probe") })) ? 0 : 1;
    break;
  case "setup":
    process.exitCode = (await runSetup()) ? 0 : 1;
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    console.error(`未知命令：${command}\n`);
    printHelp();
    process.exitCode = 1;
}
