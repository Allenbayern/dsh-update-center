# DSH 更新中心 (`@dsh-external/dsh-update-center`)

**DeepSeek Harness (DSH) 全栈零配置更新与基础设施管家插件**。

在 DSH Web 左侧栏挂载「更新中心」图标，打开即可在一张面板内完成 **DSH 本体、已装插件与本地源、Docker 容器（本机与跨节点）、APT 系统安全包、本机核心 CLI 工具链（uv / pnpm / 全局 npm CLI / Obsidian）以及本地 Python 项目虚拟环境 (`.venv`)** 的统一扫描、冲突锁定与一键升级。

**零硬编码自适应设计**：无需修改源码即可自动发现任何机器上的项目目录、虚拟环境、全局 CLI 工具、Docker 容器与 APT 状态；高级多节点拓扑或自定义锁规则可通过可选的 `~/.dsh/update-center/infra-config.json` 配置扩展。

---

## 核心能力一览

| 维度 | 自动发现与扫描机制 | 安全护栏与一键升级策略 |
|---|---|---|
| **DSH 本体** | 自动定位 `@deepseek-ai/dsh` 安装根 + 探测 npm `dist-tags` | 同时展示「正式版 (`latest`)」与「预览版 (`alpha`/`rc`/`next`)」；通过独立 `systemd` 瞬态单元 (`systemd-run`) 执行停服更新 + 健康检查 + 失败自动回滚 |
| **已装插件 & 本地源** | `pluginManager.listBundles()` + 并发 `dist-tags` 探测 | 热更新（不重启 `dsh.service`）；支持批量串行更新；本地 `link:`/`file:` 源支持与上游 tarball 逐文件 SHA-256 对比，「转为线上」前自动拦截本地未提交改动；支持 `private: true` / `protectedPackages` 本地自研包保护锁 |
| **Docker 容器** | 自动扫描本机 Docker 守护进程（若配置或存在多节点 SSH/PVE 拓扑则并发扫描多节点），对比本地与远端 Registry 镜像 Digest | **三重自动保护锁**：① `@sha256:` 固定摘要镜像自动锁定；② 无 `RepoDigests` 的本地构建镜像自动锁定；③ 容器带 `dsh.update-center.lock` 标签自动锁定。其余容器支持按 `docker compose` 工作目录一键拉取重建并清理悬空镜像 |
| **系统安全包 (APT)** | 自动检测本机及可选 PVE 宿主机 `apt list --upgradable` | 自动识别 Proxmox VE 宿主机（`/usr/bin/pveversion`）并**强制锁定内核、虚拟化核心组件、网卡 DKMS 驱动与 bootloader**（`proxmox-kernel-*`、`pve-qemu-kvm`、`zfs-*`、`r8125-dkms` 等），仅一键升级安全的非内核用户态补丁 |
| **本机核心工具链** | 自动发现 `uv`、所有 `uv tool list` 独立工具、`pnpm`、`~/.local/lib/node_modules` 下所有带 `bin` 的全局 CLI 工具，以及 `~/Applications` / `/opt` 下的 Obsidian AppImage | 支持一键执行 `uv self update`、`uv tool upgrade`、全局 CLI 更新与 GitHub Releases 最新 AppImage 下载替换 |
| **项目 Python 虚拟环境 (`.venv`)** | 自动扫描 `~/Projects`、`~/projects`、`~/workspace`、`~/code`、`~/dev`、`~/repos` 及当前工作区下的 `<project>/.venv` 或 `venv`，自动从 `pyproject.toml` / `README.md` 提取项目说明 | **零硬编码依赖冲突探测**：自动屏蔽跨大版本（Major Bump）破坏性升级；对同主版本候选包自动调用 `uv pip install --dry-run` 校验虚拟环境内上层包版本上限约束，存在冲突自动标为「锁版本」，仅一键升级 100% 兼容的同主版本安全包 |

---

## 快速安装与启用

### 1. 克隆并构建插件

```bash
mkdir -p ~/dsh-plugins
cd ~/dsh-plugins
git clone https://github.com/Allenbayern/dsh-update-center.git
cd dsh-update-center
pnpm install
pnpm run build
```

### 2. 挂载到 DSH Profile

在你的 DSH Web Profile（默认 `~/.dsh/profiles/web/package.json`）中添加本地链接依赖并启用 bundle：

```bash
pnpm --dir ~/.dsh/profiles/web add link:$HOME/dsh-plugins/dsh-update-center
```

或者在 DSH 会话中通过 `plugin_manager` 工具直接启用 `@dsh-external/dsh-update-center`。

---

## 零配置自动适配 vs 自定义配置 (`~/.dsh/update-center/infra-config.json`)

开箱即用时，插件**不需要任何配置文件**即可自动扫描本机环境与上述常见代码目录（`~/Projects`、`~/workspace` 等）。

如果你有自定义的项目根目录、跨节点 SSH / Proxmox VE 容器集群，或者希望显式锁定某些容器/插件，可以创建可选配置文件 `~/.dsh/update-center/infra-config.json`：

```json
{
  "venvScanDirs": [
    "/home/yourname/Projects",
    "/data/work/repos"
  ],
  "protectedPackages": [
    "@dsh-external/dsh-update-center",
    "my-custom-local-plugin"
  ],
  "lockedDockerContainers": {
    "my-local-app": "本地源码定制构建镜像，禁止用公共镜像覆盖"
  },
  "standaloneDockerRecreate": {
    "doocs-md": "docker pull doocs/md:latest-nginx && docker rm -f doocs-md && docker run -d --name doocs-md --restart unless-stopped -p 8080:80 doocs/md:latest-nginx && docker image prune -f"
  },
  "dockerNodes": [
    { "id": "local", "label": "Local Host (本机)", "mode": "local" },
    { "id": "router", "label": "iStoreOS (软路由)", "mode": "ssh", "sshHost": "istoreos" },
    { "id": "nas", "label": "fnOS (NAS)", "mode": "pve-qm", "pveHost": "pve", "vmid": 101 }
  ],
  "aptNodes": [
    { "id": "local", "label": "Local Host (本机)", "mode": "local", "isProxmox": false, "useSudo": true },
    { "id": "pve", "label": "PVE 宿主机", "mode": "ssh", "sshHost": "pve", "isProxmox": true, "useSudo": false }
  ],
  "venvPinnedPackages": {
    "*": {
      "some-legacy-pkg": "业务锁定特定版本"
    }
  }
}
```

### 容器级免配置锁定方式

除了在 `infra-config.json` 中声明外，你的任何 Docker 容器只要满足以下任一条件，都会被自动识别为「保护锁定」：
1. 在 `docker-compose.yml` 中添加了 label：`dsh.update-center.lock: "锁定原因说明"`；
2. 镜像引用显式固定了 `@sha256:...` 摘要；
3. 本地 `docker build` 构建且未推送至公共 Registry（无 `RepoDigests`）。

---

## Agent 工具接口 (`dsh_update_center`)

插件同时向 Agent 暴露统一的运维工具 `dsh_update_center`：

- `action="scan"`：汇总 DSH 本体、已装插件与本地源状态（支持 `refresh: true`）。
- `action="infra-scan"`：执行跨节点 Docker、APT 安全包、本机 CLI 工具链与项目 Python `.venv` 全景审计。
- `action="update"`：热更新单个 DSH 插件套件（不重启服务）。
- `action="update-all"`：串行批量更新所有可更新的 DSH 插件套件。
- `action="convert"`：将本地链接/注入插件安全转换为线上 npm registry 依赖（带本地改动 SHA-256 校验护栏）。
- `action="core-update"`：通过独立 `systemd` 瞬态单元一键更新 DSH 本体（支持 `dryRun: true`）。
- `action="docker-update"`：按节点 (`node`) 与容器名 (`name`) 一键拉取最新镜像并按 compose 配置重建容器。
- `action="apt-update"`：按节点 (`node`) 一键更新所有非内核锁定的安全 APT 包。
- `action="toolchain-update"`：按工具 ID (`name`，如 `uv`、`pnpm`、`obsidian`、`uvtool:<name>`、`npm:<name>`) 一键升级本机核心工具。
- `action="venv-update"`：按自动发现的项目 ID (`name`) 一键升级该虚拟环境内的同主版本无冲突安全包。
- `action="history"`：查看历史更新审计流水（持久化于 `~/.dsh/update-center/history.jsonl`）。

---

## HTTP 路由一览

| 路由 | 用途 |
|---|---|
| `GET api/dsh-update-center/snapshot` | DSH 本体与插件快照（支持 `mode=local` 秒开、`refresh=1` 强制重扫、`deep=1` 深度检查） |
| `GET api/dsh-update-center/badge` | 侧栏角标状态（1ms 级内存/磁盘快照读取） |
| `POST api/dsh-update-center/update` | 单插件热更新 |
| `POST api/dsh-update-center/update-all` | 批量串行更新插件 |
| `POST api/dsh-update-center/convert` | 本地源转线上依赖（含逐文件 SHA-256 差异拦截） |
| `GET/POST api/dsh-update-center/core-update` | 查询或启动 DSH 本体独立瞬态单元更新 |
| `GET/POST api/dsh-update-center/restart-service` | 查询或触发 `dsh.service` 安全重启 |
| `GET api/dsh-update-center/infra` | 读取跨节点 Docker、APT、工具链与 `.venv` 审计快照（`refresh=1` 强制重扫） |
| `POST api/dsh-update-center/infra/docker-update` | 升级指定节点与容器 |
| `POST api/dsh-update-center/infra/apt-update` | 升级指定节点的安全 APT 包 |
| `POST api/dsh-update-center/infra/toolchain-update` | 升级指定本机 CLI / 桌面工具 |
| `POST api/dsh-update-center/infra/venv-update` | 升级指定项目 `.venv` 的同主版本安全包 |
| `GET api/dsh-update-center/history` | 查询更新历史记录 |

---

## License

BSD-3-Clause
