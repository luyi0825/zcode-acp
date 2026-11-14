// zcode CLI 登录/退出登录的代理执行。
//
// 为什么需要：新装 ZCode Desktop 的机器上没有 `zcode` 命令（官方不单独分发
// CLI、安装器也不写 PATH），用户无法自己敲 login；本模块替用户定位
// 安装目录里的 zcode.cjs 并以直通终端的方式执行。
import { spawn } from "node:child_process";
import { applyZcodeRuntimeEnv, resolveZcode } from "./zcode.js";

/**
 * 直通终端执行 zcode 的固定子命令。
 * 与 runTurn 同构：spawn 在 Promise 闭包内，进程事件驱动 resolve/退出；
 * 子进程标准流接到当前终端（login 的浏览器授权提示需要用户可见），
 * 退出码原样透传。命令与参数全部是字面量（"login" / "logout" /
 * "--no-browser"），外部输入不参与构造。
 */
function runProxyCommand(extraArgs) {
  const { node, cli } = resolveZcode();
  const env = { ...process.env };
  applyZcodeRuntimeEnv(env);

  return new Promise((resolve) => {
    const child = spawn(node, [cli, ...extraArgs], {
      stdio: "inherit",
      env,
      windowsHide: true,
    });
    child.on("error", (err) => {
      console.error(`!! 无法启动 zcode：${err.message}`);
      process.exit(1);
    });
    child.on("close", (code) => process.exit(code ?? 0));
  });
}

/**
 * 登录 ZCode（浏览器授权，设备授权码轮询，无需本地回调）。
 * provider（zai / bigmodel）由 zcode 交互式引导选择。
 */
export function execLogin() {
  return runProxyCommand(["login"]);
}

/** 登录但不自动开浏览器：只打印授权 URL，适合无桌面的服务器环境。 */
export function execLoginNoBrowser() {
  return runProxyCommand(["login", "--no-browser"]);
}

/** 退出登录。 */
export function execLogout() {
  return runProxyCommand(["logout"]);
}
