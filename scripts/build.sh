#!/bin/bash
# Build: src/ --tsc--> lib/types/ --tsdown--> lib/index.js (host, esm) + lib/client.js (client, cjs)
#
# 依赖两个本机已存在的来源，都只做 symlink，不联网安装：
#   1. dsh 源码 checkout（cordis / schemastery / dsh-tools 的类型真源，同时提供 tsc）
#   2. dsh-image-gen 的 node_modules（react / @types/react / tsdown 是本机现成的）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
PNPM_HOIST="${DSH_PNPM_HOIST:-$HOME/dsh-runtime/node_modules/.pnpm/node_modules}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  if [ ! -d "$PNPM_HOIST/@deepseek-ai" ]; then
    echo "build: cannot locate the dsh checkout or dsh-runtime pnpm hoist ($PNPM_HOIST)" >&2
    exit 1
  fi
fi

# 本机现成的 JS 工具链（react 类型 + tsdown 打包器）
TOOLCHAIN="${DSH_PLUGIN_TOOLCHAIN:-$HOME/dsh-plugins/dsh-image-gen/node_modules}"

TSC="${CHECKOUT:+$CHECKOUT/node_modules/.bin/tsc}"
if [ -z "$TSC" ] || [ ! -x "$TSC" ]; then
  for tsc_cand in "$TOOLCHAIN/.bin/tsc" "$HOME/dsh-plugins/dsh-llm-fallback/node_modules/.bin/tsc" $(which tsc 2>/dev/null || true); do
    if [ -n "$tsc_cand" ] && [ -x "$tsc_cand" ]; then TSC="$tsc_cand"; break; fi
  done
fi
if [ -z "$TSC" ] || [ ! -x "$TSC" ]; then
  echo "build: tsc not found" >&2
  exit 1
fi

link_path() { # $1=node_modules 下的相对路径, $2=绝对目标
  local link="$ROOT/node_modules/$1"
  local target="$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$link" "$target"
}

link_pkg() {
  if [ -n "$CHECKOUT" ] && [ -e "$CHECKOUT/$2" ]; then
    link_path "$1" "$CHECKOUT/$2"
  elif [ -e "$PNPM_HOIST/$1" ]; then
    link_path "$1" "$PNPM_HOIST/$1"
  else
    echo "build: dependency target missing for $1" >&2
    exit 1
  fi
}

echo "=== Linking build dependencies (checkout: ${CHECKOUT:-$PNPM_HOIST}) ==="
mkdir -p node_modules/@deepseek-ai node_modules/@types
node -e "const fs=require('fs');fs.rmSync('node_modules/@standard-schema',{recursive:true,force:true})"
link_pkg @deepseek-ai/cordis vendor/cordis
link_pkg cosmokit vendor/cosmokit
link_pkg @deepseek-ai/schemastery vendor/schemastery
link_pkg @deepseek-ai/dsh-tools packages/core/tools
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-system-prompt packages/core/system-prompt
# @types/node：checkout / pnpm hoist / toolchain
if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/node_modules/@types/node" ]; then
  link_path @types/node "$CHECKOUT/node_modules/@types/node"
elif [ -d "$PNPM_HOIST/@types/node" ]; then
  link_path @types/node "$PNPM_HOIST/@types/node"
elif [ -d "$TOOLCHAIN/@types/node" ]; then
  link_path @types/node "$TOOLCHAIN/@types/node"
elif [ -d "$HOME/dsh-runtime/node_modules/.pnpm" ]; then
  PNPM_NODE_TYPES=$(find "$HOME/dsh-runtime/node_modules/.pnpm" -maxdepth 2 -type d -path '*/node_modules/@types/node' 2>/dev/null | head -1)
  if [ -n "$PNPM_NODE_TYPES" ]; then
    link_path @types/node "$PNPM_NODE_TYPES"
  else
    echo "build: @types/node not found" >&2
    exit 1
  fi
else
  echo "build: @types/node not found in checkout or toolchain ($TOOLCHAIN)" >&2
  exit 1
fi

if [ -d "$PNPM_HOIST/@standard-schema/spec" ]; then
  link_path @standard-schema/spec "$PNPM_HOIST/@standard-schema/spec"
elif [ -n "$CHECKOUT" ]; then
  STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
  if [ -n "$STD_SCHEMA" ] && [ -d "$STD_SCHEMA/node_modules/@standard-schema/spec" ]; then
    link_path @standard-schema/spec "$STD_SCHEMA/node_modules/@standard-schema/spec"
  fi
fi

echo "=== Linking JS toolchain ($TOOLCHAIN) ==="
link_path react "$TOOLCHAIN/react"
link_path @types/react "$TOOLCHAIN/@types/react"
link_path tsdown "$TOOLCHAIN/tsdown"

echo "=== Compiling src → lib/types ==="
"$TSC" -p tsconfig.json

echo "=== Bundling host + client ==="
node "$ROOT/node_modules/tsdown/dist/run.mjs" || node "$ROOT/node_modules/tsdown/dist/run.js"

echo "=== Build complete ==="
ls -la lib/index.js lib/client.js
