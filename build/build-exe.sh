#!/bin/bash
# 把 bridge 打包成不依赖 Node 的单文件可执行程序。
# Windows 产出 build/zcode-acp.exe，POSIX（Linux/macOS）产出 build/zcode-acp。
# 用途：给没有 Node 的机器用的可选形态（部分宿主只接受真正的可执行文件，
# 不接受 .cmd/.js）。npm 安装（npm i -g zcode-acp）不需要本步骤。
set -euo pipefail
cd "$(dirname "$0")/.."

UNAME="$(uname -s)"

# 默认取当前 Node 的真身路径：PATH 上的 node 可能是版本管理器 shim
# （mise/volta/fnm 的启动器，不是运行时），直接复制 shim 会打出无法运行的产物。
# process.execPath 即使经 shim 启动也指向真实二进制，Git Bash 下转成 POSIX 路径。
if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN="$(node -p 'process.execPath')"
  if command -v cygpath >/dev/null 2>&1; then
    NODE_BIN="$(cygpath -u "$NODE_BIN")"
  fi
fi

OUT="build/zcode-acp"
case "$UNAME" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) OUT="$OUT.exe" ;;
esac

echo "==> 打包为单文件 CJS"
npx --yes esbuild@0.25.0 build/sea-entry.js \
  --bundle --platform=node --format=cjs --target=node20 \
  --outfile=build/bundle.cjs

echo "==> 生成 SEA blob"
"$NODE_BIN" --experimental-sea-config build/sea-config.json

echo "==> 复制 Node 运行时并注入 blob"
cp "$(command -v "$NODE_BIN")" "$OUT"
# macOS 的 Mach-O 需要显式段名；Windows/Linux 不需要额外参数。
# ${arr[@]+...} 写法兼容 macOS 自带的 bash 3.2（set -u 下空数组展开会报错）。
POSTJECT_EXTRA=()
if [ "$UNAME" = "Darwin" ]; then
  POSTJECT_EXTRA=(--macho-segment-name NODE_SEA)
fi
npx --yes postject@1.0.0-alpha.6 "$OUT" NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  ${POSTJECT_EXTRA[@]+"${POSTJECT_EXTRA[@]}"}

# macOS（尤其 arm64）要求注入后的二进制重新 ad-hoc 签名，否则启动即被内核杀掉。
if [ "$UNAME" = "Darwin" ]; then
  codesign --sign - "$OUT" || echo "!! codesign ad-hoc 签名失败，产物可能无法在本机运行" >&2
fi

# 一些宿主在派发任务前会执行 `<产物> --version` 做 preflight，
# 空输出会被判为 runtime 不可用。构建完必须断言输出非空，防止部署旧产物。
# 直接执行产物（不能用 node 执行：Node 24 对非常规扩展名报 ERR_UNKNOWN_FILE_EXTENSION）。
VERSION_OUT="$(./"$OUT" --version)"
if [ -z "$VERSION_OUT" ]; then
  echo "!! 构建产物 --version 输出为空，禁止部署（大概率注入了旧 blob）" >&2
  exit 1
fi
echo "==> --version 自检通过：$VERSION_OUT"

echo "==> 完成：$OUT"
echo "    可复制到任意 PATH 目录后调用。"
