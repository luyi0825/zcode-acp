#!/bin/bash
# 把 bridge 打包成不依赖 Node 的单文件可执行程序 build/zcode-acp-bridge.exe。
# 用途：给没有 Node 的机器用的可选形态（部分宿主只接受真正的可执行文件，
# 不接受 .cmd/.js）。npm 安装（npm i -g zcode-acp-bridge）不需要本步骤。
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_BIN="${NODE_BIN:-node}"

echo "==> 打包为单文件 CJS"
npx --yes esbuild@0.25.0 build/sea-entry.js \
  --bundle --platform=node --format=cjs --target=node20 \
  --outfile=build/bundle.cjs

echo "==> 生成 SEA blob"
"$NODE_BIN" --experimental-sea-config build/sea-config.json

echo "==> 复制 Node 运行时并注入 blob"
cp "$(command -v "$NODE_BIN")" build/zcode-acp-bridge.exe
npx --yes postject@1.0.0-alpha.6 build/zcode-acp-bridge.exe NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 一些宿主在派发任务前会执行 `<exe> --version` 做 preflight，
# 空输出会被判为 runtime 不可用。构建完必须断言输出非空，防止部署旧产物。
# 直接执行 exe（不能用 node 执行：Node 24 对 .exe 报 ERR_UNKNOWN_FILE_EXTENSION）。
VERSION_OUT="$(./build/zcode-acp-bridge.exe --version)"
if [ -z "$VERSION_OUT" ]; then
  echo "!! 构建产物 --version 输出为空，禁止部署（大概率注入了旧 blob）" >&2
  exit 1
fi
echo "==> --version 自检通过：$VERSION_OUT"

echo "==> 完成：build/zcode-acp-bridge.exe"
echo "    可复制到任意 PATH 目录后以裸名 zcode-acp-bridge 调用。"
