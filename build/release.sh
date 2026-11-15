#!/bin/bash
# 本机一键发布：构建单文件可执行程序 → 部署到 ~/.local/bin → 版本自检。
# 旧实例仍在运行时也能部署：Windows 允许重命名被占用的 exe，POSIX 允许
# 替换/重命名运行中的文件（unlink 不影响已加载的镜像），旧进程继续跑旧镜像，
# 宿主下次拉起自然用新版本。
set -euo pipefail
cd "$(dirname "$0")/.."

bash build/build-exe.sh

NAME="zcode-acp"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) NAME="$NAME.exe" ;;
esac
SRC="build/zcode-acp"
[ -f "$SRC" ] || SRC="$SRC.exe"   # 与 build-exe.sh 的平台命名保持一致

DEST_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DEST="$DEST_DIR/$NAME"
if [[ "$DEST" == *.exe ]]; then
  OLD="${DEST%.exe}.old.exe"
else
  OLD="$DEST.old"
fi
mkdir -p "$DEST_DIR"

MOVED=""
if [ -f "$DEST" ]; then
  rm -f "$OLD" 2>/dev/null || true   # 上次遗留；仍被旧进程占用时忽略失败
  if mv "$DEST" "$OLD" 2>/dev/null; then
    MOVED="$OLD"
  elif mv "$DEST" "$OLD.$$" 2>/dev/null; then
    MOVED="$OLD.$$"                  # $OLD 仍被占用（旧进程未退出）时用唯一名
  else
    rm -f "$DEST"                    # 未被占用时直接删除
  fi
fi
cp "$SRC" "$DEST"
chmod +x "$DEST" 2>/dev/null || true  # Windows 上无意义，POSIX 确保可执行位

echo "==> 部署自检：$("$DEST" --version)（$DEST）"
if [ -n "$MOVED" ]; then
  echo "    提示：上一版已移到 $MOVED，确认无进程占用后可删。"
fi
echo "==> 完成"
