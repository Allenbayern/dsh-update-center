import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
//#region lib/types/host/semver.js
/**
* 版本比较与通道判定。
*
* semver 子集：major.minor.patch[-prerelease][+build]。
* prerelease 按 semver 规则逐段比较（数字段比数值，字母段比字典序，缺 prerelease 者更大）。
* 目的只有一个：把 npm 上的一串版本排成"谁更新"，不追求完整的 range 语义。
*/
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
function parseVersion$1(input) {
	const match = VERSION_RE.exec(input.trim());
	if (match === null) return void 0;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] === void 0 ? [] : match[4].split(".")
	};
}
function comparePrerelease(a, b) {
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1;
	if (b.length === 0) return -1;
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		const left = a[index];
		const right = b[index];
		if (left === void 0) return -1;
		if (right === void 0) return 1;
		const leftNumber = /^\d+$/.test(left) ? Number(left) : void 0;
		const rightNumber = /^\d+$/.test(right) ? Number(right) : void 0;
		if (leftNumber !== void 0 && rightNumber !== void 0) {
			if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
			continue;
		}
		if (leftNumber !== void 0) return -1;
		if (rightNumber !== void 0) return 1;
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}
/** a < b 返回负数，a > b 返回正数，相等返回 0。无法解析的版本一律视为"更旧"。 */
function compareVersions(a, b) {
	const left = parseVersion$1(a);
	const right = parseVersion$1(b);
	if (left === void 0 && right === void 0) return 0;
	if (left === void 0) return -1;
	if (right === void 0) return 1;
	if (left.major !== right.major) return left.major < right.major ? -1 : 1;
	if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
	if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
	return comparePrerelease(left.prerelease, right.prerelease);
}
/** 是否带 prerelease 后缀（alpha / beta / rc / next…）。 */
function isPrerelease(version) {
	const parsed = parseVersion$1(version);
	if (parsed === void 0) return version.includes("-");
	return parsed.prerelease.length > 0;
}
//#endregion
//#region lib/types/host/core.js
/**
* DSH 本体更新：把「预检 → 备份 → 停服 → 装新版 → 起服 → 健康检查 → 失败回滚」写成一份
* 自包含脚本，交给**独立的 systemd 瞬态单元**执行。
*
* 为什么必须脱离 dsh 自己的 cgroup：`systemctl stop dsh.service` 默认 KillMode=control-group，
* 会把发起更新的进程一起杀掉。脚本若跑在 dsh 的 cgroup 里，跑到「停服」这一步自己就没了，
* 结果是一个停着的服务 + 一个永远停在 install 阶段的状态文件。瞬态单元有自己的 cgroup，
* dsh.service 停了它还在，能把收尾和回滚做完。
*
* 状态回读全部走磁盘（result.json），因为更新完成后 dsh 进程已经换了一代，内存态没有意义。
*/
/** 已经跑完的阶段：只有这两个算终态，其余都还在过程中。 */
const TERMINAL_PHASES = /* @__PURE__ */ new Set(["done", "failed"]);
/** 一次更新超过这个时长还没终态，就认为脚本已经死了（避免按钮永久锁死）。 */
const STALE_MS = 12e5;
function isTerminalPhase(phase) {
	return phase !== void 0 && TERMINAL_PHASES.has(phase);
}
function dshHome$1() {
	return process.env.DSH_HOME !== void 0 && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
}
function updateCenterHome() {
	return join(dshHome$1(), "update-center");
}
function coreRunsDir() {
	return join(updateCenterHome(), "core-runs");
}
function readJson$2(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
function timestamp() {
	return (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
/** 只接受严格的 semver：这个值会被拼进 bash 与 pnpm 命令行。 */
function isSafeVersion(version) {
	return /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?(\+[0-9A-Za-z.]+)?$/.test(version);
}
/** 单个值的 bash 单引号转义。 */
function q(value) {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}
const WRITE_RESULT_MJS = `import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
const phase = process.argv[3] ?? ''
const okRaw = process.argv[4] ?? ''
const message = process.argv[5] ?? ''
const extraRaw = process.argv[6] ?? ''
let meta = {}
try {
  meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
} catch {}
const out = { ...meta, phase, updatedAt: new Date().toISOString() }
if (okRaw === 'true' || okRaw === 'false') out.ok = okRaw === 'true'
if (message !== '') out.message = message
if (extraRaw !== '') {
  try {
    Object.assign(out, JSON.parse(extraRaw))
  } catch {}
}
if (phase === 'done' || phase === 'failed') out.finishedAt = out.updatedAt
writeFileSync(join(dir, 'result.json'), JSON.stringify(out, null, 2))
`;
function buildScript(options, runDir, runId, unit) {
	const targetUrl = options.registry.replace(/\/+$/, "") + "/@deepseek-ai%2Fdsh/" + encodeURIComponent(options.target);
	return [
		"#!/bin/bash",
		"# 由 @dsh-external/dsh-update-center 生成：DSH 本体更新（独立瞬态单元执行）",
		"# 每一阶段都往 result.json 落一次状态，面板靠它显示进度；进程被杀也不会留下\"假进行中\"。",
		"set -uo pipefail",
		"export PATH=" + q([
			join(homedir(), ".local/bin"),
			"/usr/local/bin",
			"/usr/bin",
			"/bin"
		].join(":")),
		"export HOME=" + q(homedir()),
		"RUN_DIR=" + q(runDir),
		"RESULT=\"$RUN_DIR/result.json\"",
		"LOG=\"$RUN_DIR/update.log\"",
		"RUNTIME=" + q(options.runtimeDir),
		"PKG=" + q("@deepseek-ai/dsh"),
		"TARGET=" + q(options.target),
		"OLD=" + q(options.from),
		"SERVICE=" + q(options.serviceName),
		"HEALTH=" + q(options.healthUrl),
		"TARGET_URL=" + q(targetUrl),
		"DRY_RUN=" + q(options.dryRun === true ? "1" : "0"),
		"GRACE=" + q(String(Math.max(0, Math.floor(options.graceSeconds ?? 10)))),
		"MANIFEST=\"$RUNTIME/node_modules/@deepseek-ai/dsh/package.json\"",
		"exec >>\"$LOG\" 2>&1",
		"",
		"say() { echo \"[$(date '+%H:%M:%S')] $*\"; }",
		"res() { node \"$RUN_DIR/write-result.mjs\" \"$RUN_DIR\" \"$1\" \"${2:-}\" \"${3:-}\" \"${4:-}\"; }",
		"installed_version() { node -e 'try{process.stdout.write(require(process.argv[1]).version)}catch(e){}' \"$MANIFEST\"; }",
		"LAST_STATE=unknown",
		"LAST_CODE=000",
		"# 健康判定：DSH 的根路径要登录，正常也返回 401；只有「连不上(000)」和 5xx 才算没起来。",
		"# 2026-11-03 教训：早先只认 2xx/3xx，把一次成功的更新误判成失败并回滚了。",
		"health_ok() {",
		"  local i",
		"  for i in $(seq 1 45); do",
		"    LAST_STATE=$(systemctl is-active \"$SERVICE\" 2>/dev/null)",
		"    LAST_CODE=$(curl -s -o /dev/null -w \"%{http_code}\" --max-time 3 \"$HEALTH\" 2>/dev/null)",
		"    if [ \"$LAST_STATE\" = \"active\" ]; then",
		"      case \"${LAST_CODE:-000}\" in",
		"        2*|3*|401|403) return 0 ;;",
		"      esac",
		"    fi",
		"    sleep 2",
		"  done",
		"  return 1",
		"}",
		"",
		"say \"== DSH 本体更新：$OLD -> $TARGET ==\"",
		"res preflight \"\" \"开始预检\"",
		"",
		"# 1. 预检：磁盘余量 + 上游版本可达",
		"free_kb=$(df -Pk \"$RUNTIME\" 2>/dev/null | awk 'NR==2 {print $4}')",
		"if [ -z \"${free_kb:-}\" ] || [ \"$free_kb\" -lt 2097152 ]; then",
		"  say \"预检失败：磁盘可用空间不足 2GB（${free_kb:-0}KB）\"",
		"  res failed false \"磁盘可用空间不足 2GB\"",
		"  exit 1",
		"fi",
		"say \"磁盘可用：$((free_kb / 1024)) MB\"",
		"if ! curl -fsS --max-time 25 -o /dev/null \"$TARGET_URL\"; then",
		"  say \"预检失败：上游查不到 $TARGET\"",
		"  res failed false \"上游 registry 查不到 $TARGET（网络或版本号有误）\"",
		"  exit 1",
		"fi",
		"say \"上游 $TARGET 可达\"",
		"if [ \"$DRY_RUN\" = \"1\" ]; then",
		"  say \"dry-run：预检通过，未备份、未停服、未安装\"",
		"  res done true \"预检通过（dry-run：未停服、未安装）\"",
		"  exit 0",
		"fi",
		"",
		"# 2. 备份",
		"res backup \"\" \"备份 package.json / pnpm-lock.yaml / pnpm-workspace.yaml\"",
		"cp -a \"$RUNTIME/package.json\" \"$RUN_DIR/package.json.bak\" || true",
		"if [ -f \"$RUNTIME/pnpm-lock.yaml\" ]; then cp -a \"$RUNTIME/pnpm-lock.yaml\" \"$RUN_DIR/pnpm-lock.yaml.bak\" || true; fi",
		"# pnpm 12 会往 workspace 文件里追加 minimumReleaseAgeExclude，必须一起备份",
		"if [ -f \"$RUNTIME/pnpm-workspace.yaml\" ]; then cp -a \"$RUNTIME/pnpm-workspace.yaml\" \"$RUN_DIR/pnpm-workspace.yaml.bak\" || true; fi",
		"",
		"# 3. 停服",
		"# 停服前留余量：面板能先把「更新中」状态和日志落下来，操作者也有个准备。",
		"if [ \"$GRACE\" -gt 0 ]; then",
		"  say \"等待 ${GRACE}s 后停服…\"",
		"  sleep \"$GRACE\"",
		"fi",
		"res stop \"\" \"停止 $SERVICE\"",
		"sudo -n systemctl stop \"$SERVICE\"",
		"for i in $(seq 1 40); do",
		"  state=$(systemctl is-active \"$SERVICE\" 2>/dev/null)",
		"  if [ \"$state\" != \"active\" ] && [ \"$state\" != \"activating\" ]; then break; fi",
		"  sleep 1",
		"done",
		"say \"服务状态：$(systemctl is-active \"$SERVICE\" 2>/dev/null)\"",
		"",
		"# 4. 安装",
		"res install \"\" \"pnpm add $PKG@$TARGET\"",
		"install_ok=1",
		"if ! pnpm --dir \"$RUNTIME\" add \"$PKG@$TARGET\" --reporter=append-only; then install_ok=0; fi",
		"got=$(installed_version)",
		"say \"磁盘上的版本：${got:-未知}\"",
		"if [ \"$got\" != \"$TARGET\" ]; then install_ok=0; fi",
		"",
		"rollback() {",
		"  res rollback \"\" \"回滚到 $OLD\"",
		"  say \"开始回滚：pnpm add $PKG@$OLD\"",
		"  pnpm --dir \"$RUNTIME\" add \"$PKG@$OLD\" --reporter=append-only || say \"回滚安装失败，需要人工介入\"",
		"  say \"回滚后磁盘版本：$(installed_version)\"",
		"  # 必须 restart 而不是 start：失败时服务往往还是 active（跑着新版代码），",
		"  # start 是空操作，进程会继续跑内存里的新版，磁盘却是旧版——两边不一致。",
		"  sudo -n systemctl restart \"$SERVICE\" || true",
		"  if health_ok; then say \"回滚后服务已恢复（state=$LAST_STATE code=$LAST_CODE）\"; else say \"回滚后服务未恢复健康（state=$LAST_STATE code=$LAST_CODE），需要人工介入\"; fi",
		"}",
		"",
		"if [ \"$install_ok\" -ne 1 ]; then",
		"  say \"安装 $TARGET 失败，进入回滚\"",
		"  rollback",
		"  res failed false \"安装 $TARGET 失败，已回滚到 $OLD\" '{\"rolledBack\":true}'",
		"  exit 1",
		"fi",
		"",
		"# 5. 起服 + 健康检查",
		"res start \"\" \"启动 $SERVICE\"",
		"sudo -n systemctl start \"$SERVICE\"",
		"res health \"\" \"等待 $HEALTH 健康检查\"",
		"if health_ok; then",
		"  say \"健康检查通过（state=$LAST_STATE code=$LAST_CODE）：$TARGET 已生效\"",
		"  res done true \"已更新到 $TARGET 并重启完成（HTTP $LAST_CODE）\"",
		"  exit 0",
		"fi",
		"say \"健康检查超时（state=$LAST_STATE code=$LAST_CODE），进入回滚\"",
		"say \"最近 30 行服务日志：\"",
		"journalctl -u \"$SERVICE\" -n 30 --no-pager 2>/dev/null || true",
		"rollback",
		"res failed false \"$TARGET 启动后健康检查超时（state=$LAST_STATE code=$LAST_CODE），已回滚到 $OLD\" '{\"rolledBack\":true}'",
		"exit 1"
	].join("\n");
}
/** 列出所有本体更新 run（新→旧）。 */
function listCoreRuns() {
	const dir = coreRunsDir();
	if (!existsSync(dir)) return [];
	const runs = [];
	for (const name of readdirSync(dir).sort().reverse()) {
		const state = readCoreRun(name);
		if (state !== void 0) runs.push(state);
	}
	return runs;
}
function readCoreRun(runId) {
	const runDir = join(coreRunsDir(), runId);
	const result = readJson$2(join(runDir, "result.json"));
	const meta = readJson$2(join(runDir, "meta.json"));
	if (result === void 0 && meta === void 0) return void 0;
	return {
		runId,
		target: String(result?.target ?? meta?.target ?? ""),
		from: result?.from ?? meta?.from,
		phase: String(result?.phase ?? "launching"),
		startedAt: String(result?.startedAt ?? meta?.startedAt ?? ""),
		...result === void 0 ? {} : result
	};
}
/** 最近一次更新是不是还在跑（供面板锁按钮）。 */
function coreUpdateInFlight(run) {
	if (run === void 0) return false;
	if (isTerminalPhase(run.phase)) return false;
	const at = Date.parse(run.updatedAt ?? run.startedAt);
	if (Number.isNaN(at)) return true;
	return Date.now() - at < STALE_MS;
}
function sudoAvailable() {
	return new Promise((done) => {
		execFile("sudo", ["-n", "true"], { timeout: 5e3 }, (error) => done(error === null));
	});
}
function systemdRunAvailable() {
	return new Promise((done) => {
		execFile("systemd-run", ["--version"], { timeout: 5e3 }, (error) => done(error === null));
	});
}
/**
* 发射一次本体更新：写脚本 + meta，然后用 `sudo systemd-run` 起一个瞬态单元跑它。
* 立刻返回，不等更新结束（也等不到——服务会重启）。
*/
async function launchCoreUpdate(options) {
	if (!isSafeVersion(options.target) || !isSafeVersion(options.from)) return {
		ok: false,
		message: "版本号不合法，拒绝执行"
	};
	if (!existsSync(join(options.runtimeDir, "package.json"))) return {
		ok: false,
		message: "运行时目录不可用：" + options.runtimeDir
	};
	if (!await sudoAvailable()) return {
		ok: false,
		message: "需要免密 sudo 才能停起 dsh.service（sudo -n 不可用）"
	};
	if (!await systemdRunAvailable()) return {
		ok: false,
		message: "找不到 systemd-run，无法把更新放到独立单元里执行"
	};
	const runId = timestamp();
	const runDir = join(coreRunsDir(), runId);
	mkdirSync(runDir, { recursive: true });
	const unit = "dsh-core-update-" + runId.toLowerCase().replace(/[^a-z0-9]/g, "");
	const meta = {
		runId,
		target: options.target,
		from: options.from,
		phase: "launching",
		startedAt: (/* @__PURE__ */ new Date()).toISOString(),
		updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		runtimeDir: options.runtimeDir,
		serviceName: options.serviceName,
		healthUrl: options.healthUrl,
		unit,
		dryRun: options.dryRun === true,
		logPath: join(runDir, "update.log")
	};
	writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
	writeFileSync(join(runDir, "result.json"), JSON.stringify({
		...meta,
		phase: "launching"
	}, null, 2));
	writeFileSync(join(runDir, "write-result.mjs"), WRITE_RESULT_MJS);
	const scriptPath = join(runDir, "update.sh");
	writeFileSync(scriptPath, buildScript(options, runDir, runId, unit));
	chmodSync(scriptPath, 493);
	const user = userInfo().username;
	const args = [
		"-n",
		"systemd-run",
		"--collect",
		"--quiet",
		"--unit=" + unit,
		"--description=DSH core update " + options.from + " -> " + options.target,
		"--uid=" + user,
		"--setenv=HOME=" + homedir(),
		"--setenv=PATH=" + join(homedir(), ".local/bin") + ":/usr/local/bin:/usr/bin:/bin",
		"--working-directory=" + homedir(),
		"/bin/bash",
		scriptPath
	];
	return await new Promise((done) => {
		execFile("sudo", args, { timeout: 2e4 }, (error, stdout, stderr) => {
			if (error !== null) {
				const detail = (String(stderr ?? "") + String(stdout ?? "")).trim().slice(0, 400);
				writeFileSync(join(runDir, "result.json"), JSON.stringify({
					...meta,
					phase: "failed",
					ok: false,
					message: "无法启动更新单元：" + (detail === "" ? String(error) : detail),
					updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
					finishedAt: (/* @__PURE__ */ new Date()).toISOString()
				}, null, 2));
				done({
					ok: false,
					runId,
					runDir,
					logPath: meta.logPath,
					message: "无法启动更新单元：" + (detail === "" ? String(error) : detail)
				});
				return;
			}
			done({
				ok: true,
				runId,
				runDir,
				logPath: meta.logPath,
				unit,
				message: "已启动更新单元 " + unit + "（" + options.from + " → " + options.target + "）"
			});
		});
	});
}
/** 读某次 run 的日志尾巴（面板展开看）。 */
function readCoreLog(runId, lines = 80) {
	const path = join(coreRunsDir(), runId, "update.log");
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
	} catch {
		return "";
	}
}
function restartRunsDir() {
	return join(updateCenterHome(), "restart-runs");
}
function buildRestartScript(options, runDir) {
	return [
		"#!/bin/bash",
		"# 由 @dsh-external/dsh-update-center 生成：只重启 dsh.service（独立瞬态单元执行）",
		"set -uo pipefail",
		"export PATH=" + q([
			join(homedir(), ".local/bin"),
			"/usr/local/bin",
			"/usr/bin",
			"/bin"
		].join(":")),
		"export HOME=" + q(homedir()),
		"RUN_DIR=" + q(runDir),
		"RESULT=\"$RUN_DIR/result.json\"",
		"LOG=\"$RUN_DIR/restart.log\"",
		"SERVICE=" + q(options.serviceName),
		"HEALTH=" + q(options.healthUrl),
		"GRACE=" + q(String(Math.max(0, Math.floor(options.graceSeconds ?? 8)))),
		"exec >>\"$LOG\" 2>&1",
		"",
		"say() { echo \"[$(date '+%H:%M:%S')] $*\"; }",
		"res() { node \"$RUN_DIR/write-result.mjs\" \"$RUN_DIR\" \"$1\" \"${2:-}\" \"${3:-}\" \"${4:-}\"; }",
		"LAST_STATE=unknown",
		"LAST_CODE=000",
		"# 根路径要登录，正常也回 401；只有连不上(000)与 5xx 才算没起来。",
		"health_ok() {",
		"  local i",
		"  for i in $(seq 1 45); do",
		"    LAST_STATE=$(systemctl is-active \"$SERVICE\" 2>/dev/null)",
		"    LAST_CODE=$(curl -s -o /dev/null -w \"%{http_code}\" --max-time 3 \"$HEALTH\" 2>/dev/null)",
		"    if [ \"$LAST_STATE\" = \"active\" ]; then",
		"      case \"${LAST_CODE:-000}\" in",
		"        2*|3*|401|403) return 0 ;;",
		"      esac",
		"    fi",
		"    sleep 2",
		"  done",
		"  return 1",
		"}",
		"",
		"say \"== 重启 $SERVICE（grace ${GRACE}s） ==\"",
		"res restarting \"\" \"等待 ${GRACE}s 后重启 $SERVICE\"",
		"sleep \"$GRACE\"",
		"if ! sudo -n systemctl restart \"$SERVICE\"; then",
		"  say \"systemctl restart 失败\"",
		"  res failed false \"systemctl restart $SERVICE 失败（需要免密 sudo）\"",
		"  exit 1",
		"fi",
		"res health \"\" \"等待 $HEALTH 健康检查\"",
		"if health_ok; then",
		"  say \"重启完成（state=$LAST_STATE code=$LAST_CODE）\"",
		"  res done true \"服务已重启并恢复（HTTP $LAST_CODE）\"",
		"  exit 0",
		"fi",
		"say \"健康检查超时（state=$LAST_STATE code=$LAST_CODE）\"",
		"journalctl -u \"$SERVICE\" -n 30 --no-pager 2>/dev/null || true",
		"res failed false \"重启后健康检查超时（state=$LAST_STATE code=$LAST_CODE）\"",
		"exit 1"
	].join("\n");
}
async function launchServiceRestart(options) {
	if (!await sudoAvailable()) return {
		ok: false,
		message: "需要免密 sudo 才能重启 dsh.service（sudo -n 不可用）"
	};
	if (!await systemdRunAvailable()) return {
		ok: false,
		message: "找不到 systemd-run，无法把重启放到独立单元里执行"
	};
	const runId = timestamp();
	const runDir = join(restartRunsDir(), runId);
	mkdirSync(runDir, { recursive: true });
	const unit = "dsh-service-restart-" + runId.toLowerCase().replace(/[^a-z0-9]/g, "");
	const meta = {
		runId,
		phase: "launching",
		startedAt: (/* @__PURE__ */ new Date()).toISOString(),
		updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		serviceName: options.serviceName,
		healthUrl: options.healthUrl,
		unit,
		logPath: join(runDir, "restart.log")
	};
	writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
	writeFileSync(join(runDir, "result.json"), JSON.stringify(meta, null, 2));
	writeFileSync(join(runDir, "write-result.mjs"), WRITE_RESULT_MJS);
	const scriptPath = join(runDir, "restart.sh");
	writeFileSync(scriptPath, buildRestartScript(options, runDir));
	chmodSync(scriptPath, 493);
	const args = [
		"-n",
		"systemd-run",
		"--collect",
		"--quiet",
		"--unit=" + unit,
		"--description=DSH service restart",
		"--uid=" + userInfo().username,
		"--setenv=HOME=" + homedir(),
		"--setenv=PATH=" + join(homedir(), ".local/bin") + ":/usr/local/bin:/usr/bin:/bin",
		"--working-directory=" + homedir(),
		"/bin/bash",
		scriptPath
	];
	return await new Promise((done) => {
		execFile("sudo", args, { timeout: 2e4 }, (error, stdout, stderr) => {
			if (error !== null) {
				const detail = (String(stderr ?? "") + String(stdout ?? "")).trim().slice(0, 400);
				writeFileSync(join(runDir, "result.json"), JSON.stringify({
					...meta,
					phase: "failed",
					ok: false,
					message: "无法启动重启单元：" + (detail === "" ? String(error) : detail),
					updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
					finishedAt: (/* @__PURE__ */ new Date()).toISOString()
				}, null, 2));
				done({
					ok: false,
					runId,
					runDir,
					logPath: meta.logPath,
					message: "无法启动重启单元：" + (detail === "" ? String(error) : detail)
				});
				return;
			}
			done({
				ok: true,
				runId,
				runDir,
				logPath: meta.logPath,
				unit,
				message: "已启动重启单元 " + unit
			});
		});
	});
}
function readRestartRun(runId) {
	const runDir = join(restartRunsDir(), runId);
	const result = readJson$2(join(runDir, "result.json"));
	const meta = readJson$2(join(runDir, "meta.json"));
	if (result === void 0 && meta === void 0) return void 0;
	return {
		runId,
		...meta,
		...result
	};
}
function listRestartRuns() {
	const dir = restartRunsDir();
	if (!existsSync(dir)) return [];
	const runs = [];
	for (const name of readdirSync(dir).sort().reverse()) {
		const run = readRestartRun(name);
		if (run !== void 0) runs.push(run);
	}
	return runs;
}
function readRestartLog(runId, lines = 80) {
	const path = join(restartRunsDir(), runId, "restart.log");
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
	} catch {
		return "";
	}
}
//#endregion
//#region lib/types/host/upstream-compare.js
/**
* 本地目录 vs 上游同版本 tarball 的逐文件比对。
*
* 用途：`link:` / 注入这些本地源的版本号常常跟上游一模一样，但内容可能早被本地改过
* （打补丁、改构建产物、加功能）。只看版本号就点「转线上」，会把本地改动静默扔掉。
* 所以在给出「转为线上」按钮之前，先把本地目录和上游那一版的 tarball 对一遍。
*
* 口径：
*   - 比相对路径 + 文件 sha256，跳过 node_modules / .git；
*   - 上游 tarball 按 `<name>@<version>` 缓存到 `~/.dsh/update-center/upstream-cache/`，
*     同一版本只下载一次（发布版不可变，缓存永远有效）；
*   - 比对失败（下载不了 / 解包失败 / 目录不存在）就返回 unknown，**不猜**。
*/
const SKIP_DIRS = /* @__PURE__ */ new Set([
	"node_modules",
	".git",
	".cache",
	".turbo"
]);
/** 单个 tarball 上限：超过就不比了（真出现这么大的包，转线上本来就该人工确认）。 */
const MAX_TARBALL_BYTES = 41943040;
const MAX_LISTED_FILES = 12;
function cacheDirFor(name, version) {
	return join(updateCenterHome(), "upstream-cache", name.replace(/[/@]/g, "_") + "@" + version);
}
function walkFiles(root, prefix = "") {
	const out = /* @__PURE__ */ new Map();
	let entries;
	try {
		entries = readdirSync(join(root, prefix));
	} catch {
		return out;
	}
	for (const entry of entries) {
		const rel = prefix === "" ? entry : prefix + sep + entry;
		const abs = join(root, rel);
		let stats;
		try {
			stats = statSync(abs);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			if (SKIP_DIRS.has(entry)) continue;
			for (const [key, value] of walkFiles(root, rel)) out.set(key, value);
			continue;
		}
		if (!stats.isFile()) continue;
		try {
			out.set(rel.split(sep).join("/"), createHash("sha256").update(new Uint8Array(readFileSync(abs))).digest("hex"));
		} catch {}
	}
	return out;
}
function download(url, target, timeoutMs) {
	return new Promise((done) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		fetch(url, {
			signal: controller.signal,
			headers: { accept: "application/octet-stream" }
		}).then(async (response) => {
			if (!response.ok) {
				done(false);
				return;
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength === 0 || bytes.byteLength > MAX_TARBALL_BYTES) {
				done(false);
				return;
			}
			writeFileSync(target, bytes);
			done(true);
		}).catch(() => done(false)).finally(() => clearTimeout(timer));
	});
}
function extract(tarball, into) {
	return new Promise((done) => {
		execFile("tar", [
			"-xzf",
			tarball,
			"-C",
			into,
			"--strip-components=1"
		], { timeout: 6e4 }, (error) => {
			done(error === null);
		});
	});
}
/** 拿到（必要时下载并解包的）上游同版本目录；失败返回 undefined。 */
async function upstreamDir(name, version, tarballUrl, timeoutMs) {
	const cacheDir = cacheDirFor(name, version);
	const pkgDir = join(cacheDir, "pkg");
	const marker = join(cacheDir, ".complete");
	if (existsSync(marker) && existsSync(pkgDir)) return { dir: pkgDir };
	try {
		mkdirSync(cacheDir, { recursive: true });
	} catch (error) {
		return { reason: "建缓存目录失败：" + String(error) };
	}
	const tarball = join(cacheDir, "package.tgz");
	if (!await download(tarballUrl, tarball, Math.max(15e3, timeoutMs * 4))) return { reason: "上游 tarball 下载失败（网络或体积超限）" };
	try {
		rmSync(pkgDir, {
			recursive: true,
			force: true
		});
	} catch {}
	mkdirSync(pkgDir, { recursive: true });
	if (!await extract(tarball, pkgDir)) return { reason: "上游 tarball 解包失败" };
	try {
		writeFileSync(marker, (/* @__PURE__ */ new Date()).toISOString());
		rmSync(tarball, { force: true });
	} catch {}
	return { dir: pkgDir };
}
async function compareLocalWithUpstream(options) {
	const { dir, name, version, tarballUrl, timeoutMs } = options;
	if (dir === void 0 || dir === "") return {
		status: "unknown",
		version,
		reason: "没有本地目录可比对"
	};
	if (!existsSync(dir)) return {
		status: "unknown",
		version,
		reason: "本地目录不存在：" + dir
	};
	if (tarballUrl === void 0 || tarballUrl === "") return {
		status: "unknown",
		version,
		reason: "上游没有给出 tarball 地址"
	};
	const upstream = await upstreamDir(name, version, tarballUrl, timeoutMs);
	if ("reason" in upstream) return {
		status: "unknown",
		version,
		reason: upstream.reason
	};
	const localFiles = walkFiles(dir);
	const upstreamFiles = walkFiles(upstream.dir);
	const modified = [];
	const localOnly = [];
	const upstreamOnly = [];
	for (const [rel, hash] of localFiles) {
		const other = upstreamFiles.get(rel);
		if (other === void 0) localOnly.push(rel);
		else if (other !== hash) modified.push(rel);
	}
	for (const rel of upstreamFiles.keys()) if (!localFiles.has(rel)) upstreamOnly.push(rel);
	modified.sort();
	localOnly.sort();
	upstreamOnly.sort();
	const changed = [
		...modified,
		...localOnly,
		...upstreamOnly
	];
	if (changed.length === 0) return {
		status: "identical",
		version,
		changedCount: 0,
		modifiedCount: 0,
		localOnlyCount: 0,
		upstreamOnlyCount: 0,
		changedFiles: []
	};
	return {
		status: "modified",
		version,
		changedCount: changed.length,
		modifiedCount: modified.length,
		localOnlyCount: localOnly.length,
		upstreamOnlyCount: upstreamOnly.length,
		changedFiles: changed.slice(0, MAX_LISTED_FILES)
	};
}
//#endregion
//#region lib/types/host/scan.js
/**
* 只读扫描：把"本机装了什么、上游有什么"整理成一份快照。
*
* 数据来源三层：
* 1. pluginManager（宿主官方服务）——已装套件/插件的版本、来源与可更新性；
* 2. npm registry dist-tags + pnpm view（经 pluginManager.listVersions）——上游版本；
* 3. 本机文件与命令——DSH 本体安装位置、注入插件注册表、node/pnpm/服务状态。
*
* 这里不做任何写入：唯一写路径是 index.ts 里的 updateBundle。
*/
function readJson$1(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
function dshHome() {
	return process.env.DSH_HOME !== void 0 && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
}
/** 从运行中的入口脚本往上找到 @deepseek-ai/dsh 包根，再兜底常见安装位置。 */
function findCoreRoot() {
	let dir;
	const entry = process.argv[1];
	if (entry !== void 0) dir = dirname(resolve(entry));
	while (dir !== void 0) {
		if (readJson$1(join(dir, "package.json"))?.name === "@deepseek-ai/dsh") return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const candidates = [join(homedir(), "dsh-runtime/node_modules/@deepseek-ai/dsh"), join(dshHome(), "runtime/node_modules/@deepseek-ai/dsh")];
	for (const candidate of candidates) if (existsSync(join(candidate, "package.json"))) return candidate;
}
/** 本体安装的运行时根（`…/node_modules/@deepseek-ai/dsh` 往上三层）。 */
function coreRuntimeDir() {
	const root = findCoreRoot();
	if (root === void 0) return void 0;
	const dir = dirname(dirname(dirname(root)));
	return existsSync(join(dir, "package.json")) ? dir : void 0;
}
function findProfileDir() {
	const explicit = process.env.DSH_PROFILE;
	const profilesDir = join(dshHome(), "profiles");
	if (explicit !== void 0 && existsSync(join(profilesDir, explicit, "package.json"))) return join(profilesDir, explicit);
	const guess = join(profilesDir, "web");
	if (existsSync(join(guess, "package.json"))) return guess;
}
/** npm 的 dist-tags 端点：只回几十字节，比拉整包文档轻得多。 */
async function fetchDistTags(registry, name, timeoutMs) {
	const encoded = name.startsWith("@") ? "@" + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
	const url = registry.replace(/\/+$/, "") + "/-/package/" + encoded + "/dist-tags";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { accept: "application/json" }
		});
		if (!response.ok) return void 0;
		const body = await response.json();
		if (body === null || typeof body !== "object") return void 0;
		const tags = {};
		for (const [key, value] of Object.entries(body)) if (typeof value === "string") tags[key] = value;
		return Object.keys(tags).length > 0 ? tags : void 0;
	} catch {
		return;
	} finally {
		clearTimeout(timer);
	}
}
/** 单个版本的 manifest：只用来读 `dsh.bundle` 声明，几百字节到几 KB。 */
async function fetchVersionManifest(registry, name, version, timeoutMs) {
	const encodedName = name.startsWith("@") ? "@" + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
	const url = registry.replace(/\/+$/, "") + "/" + encodedName + "/" + encodeURIComponent(version);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { accept: "application/json" }
		});
		if (!response.ok) return void 0;
		return await response.json();
	} catch {
		return;
	} finally {
		clearTimeout(timer);
	}
}
/**
* 上游有没有同名包、能不能把这条本地源换成线上依赖。
*
* 只做只读判断，真正的转换在 host/convert.ts。判定口径：
*   - 上游查不到（404 / 私有 401）→ 不可转；
*   - 上游最新版低于本地 → 不可转（那是降级）；
*   - 上游这一版没有 `dsh.bundle` → 不可转（装上不会生效）。
*/
/**
* 本地自研受保护包判定：
*   1. `@dsh-external/` 命名空间下的本地外置扩展；
*   2. `~/.dsh/update-center/infra-config.json` 中 `protectedPackages` 配置的包名；
*   3. 本地源码目录（`link:` / `file:`）下的 `package.json` 含 `"private": true` 或 `"dshProtected": true`；
*   4. 内置默认受保护包白名单。
*/
const LOCAL_PROTECTED_PACKAGES = /* @__PURE__ */ new Set(["@dsh-external/dsh-update-center", "dsh-update-center"]);
function readUserProtectedPackages() {
	const cfg = readJson$1(join(dshHome(), "update-center", "infra-config.json"));
	const set = new Set(LOCAL_PROTECTED_PACKAGES);
	if (Array.isArray(cfg?.protectedPackages)) {
		for (const item of cfg.protectedPackages) if (typeof item === "string" && item.trim() !== "") set.add(item.trim());
	}
	return set;
}
function isLocalProtectedPackage(name, localDir) {
	if (name.startsWith("@dsh-external/")) return true;
	if (readUserProtectedPackages().has(name)) return true;
	if (localDir !== void 0 && localDir !== "") {
		const pkg = readJson$1(join(localDir, "package.json"));
		if (pkg?.private === true || pkg?.dshProtected === true || pkg?.dsh?.protected === true) return true;
	}
	return false;
}
async function probeUpstream(registry, name, installed, timeoutMs, localDir) {
	if (isLocalProtectedPackage(name, localDir)) return {
		found: false,
		convertible: false,
		reason: "本地自研受保护包（白名单/private 锁定，不转公共 npm 源）"
	};
	const tags = await fetchDistTags(registry, name, timeoutMs);
	if (tags === void 0) return {
		found: false,
		convertible: false,
		reason: "上游查不到同名包（未发布或私有源）"
	};
	const tagVersions = Object.values(tags);
	const latest = tags.latest ?? tagVersions.sort((left, right) => compareVersions(right, left))[0];
	if (latest === void 0) return {
		found: false,
		convertible: false,
		reason: "上游没有可用的版本标签"
	};
	const manifest = await fetchVersionManifest(registry, name, latest, timeoutMs);
	const bundle = manifest === void 0 ? void 0 : manifest?.dsh?.bundle !== void 0 && manifest?.dsh?.bundle !== null;
	const tarballUrl = typeof manifest?.dist?.tarball === "string" ? manifest.dist.tarball : void 0;
	const position = installed === void 0 || installed === "" ? "unknown" : compareVersions(latest, installed) > 0 ? "newer" : compareVersions(latest, installed) === 0 ? "same" : "older";
	const base = {
		found: true,
		version: latest,
		...bundle === void 0 ? {} : { bundle },
		position,
		convertible: false,
		...tarballUrl === void 0 ? {} : { tarballUrl }
	};
	if (position === "older") return {
		...base,
		reason: "上游最新 " + latest + " 低于本地 " + String(installed) + "（转过去等于降级）"
	};
	if (bundle === false) return {
		...base,
		reason: "上游这一版没有 dsh.bundle 声明，装上不会作为套件生效"
	};
	return {
		...base,
		convertible: true
	};
}
/** 通道候选：正式版取"最新且非 prerelease"，预览版取"最新（prerelease 也算）"。 */ function pickChannels(versions, tagsOf) {
	const sorted = [...versions].sort((left, right) => compareVersions(right.version, left.version));
	const toHit = (entry) => ({
		version: entry.version,
		tags: tagsOf(entry.version),
		...entry.publishedAt === void 0 ? {} : { publishedAt: entry.publishedAt },
		...entry.deprecated === void 0 ? {} : { deprecated: entry.deprecated }
	});
	const stable = sorted.find((entry) => !isPrerelease(entry.version));
	const preview = sorted[0];
	return {
		...stable === void 0 ? {} : { stable: toHit(stable) },
		...preview === void 0 ? {} : { preview: toHit(preview) }
	};
}
function statusOf(installed, channels) {
	if (channels.stable === void 0 && channels.preview === void 0) return "latest";
	const target = channels.preview;
	if (installed === void 0 || target === void 0) return "unknown";
	if (compareVersions(target.version, installed) <= 0) return "local-ahead";
	if (channels.stable !== void 0 && compareVersions(channels.stable.version, installed) > 0) return "update";
	return "preview-only";
}
/** 本地源对应的绝对目录：`link:` 去掉前缀，`file:` / 裸路径直接用。 */
function localDirOf(source) {
	if (source === void 0 || source === "") return void 0;
	if (source.startsWith("link:")) return source.slice(5);
	if (source.startsWith("file:")) return source.slice(5);
	if (source.startsWith("/")) return source;
}
function classifySource(source) {
	if (source === void 0 || source === "") return "npm";
	if (source.startsWith("link:")) return "link";
	if (source.startsWith("file:")) return "local";
	if (source.startsWith("github:") || source.includes("git+") || source.endsWith(".git")) return "git";
	if (source.startsWith("http") && (source.endsWith(".tgz") || source.includes(".tgz?"))) return "tarball";
	return "npm";
}
async function execText(command, args, timeout) {
	return await new Promise((done) => {
		execFile(command, args, {
			timeout,
			maxBuffer: 1 << 20,
			env: process.env
		}, (error, stdout) => {
			if (error !== null) {
				done(void 0);
				return;
			}
			done(String(stdout).trim());
		});
	});
}
async function probeEnv(deep, timeoutMs) {
	const [pnpm, git, active, since, os] = await Promise.all([
		execText("pnpm", ["--version"], timeoutMs),
		execText("git", ["--version"], timeoutMs),
		execText("systemctl", ["is-active", "dsh.service"], timeoutMs),
		execText("systemctl", [
			"show",
			"dsh.service",
			"-p",
			"ActiveEnterTimestamp",
			"--value"
		], timeoutMs),
		execText("bash", ["-lc", ". /etc/os-release 2>/dev/null && printf \"%s\" \"${PRETTY_NAME:-}\""], timeoutMs)
	]);
	const facts = {
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		dshHome: dshHome(),
		...findProfileDir() === void 0 ? {} : { profileDir: findProfileDir() },
		...pnpm === void 0 ? {} : { pnpm },
		...git === void 0 ? {} : { git },
		service: {
			name: "dsh.service",
			...active === void 0 ? {} : { active },
			...since === void 0 || since === "" ? {} : { since }
		},
		...os === void 0 || os === "" ? {} : { os },
		deepChecked: false
	};
	if (deep) {
		facts.deepChecked = true;
		const listing = await execText("bash", ["-lc", "apt list --upgradable 2>/dev/null"], 2e4);
		if (listing === void 0) facts.upgradable = {
			sample: [],
			error: "apt 不可用或超时"
		};
		else {
			const lines = listing.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("Listing"));
			facts.upgradable = {
				count: lines.length,
				sample: lines.slice(0, 8).map((line) => line.split(" ")[0] ?? line)
			};
		}
	}
	return facts;
}
function readInjections() {
	const registryPath = join(dshHome(), "super-injector", "registry.json");
	const raw = readJson$1(registryPath);
	if (!Array.isArray(raw)) return {
		registryPath,
		entries: []
	};
	return {
		registryPath,
		entries: raw.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.name === "string").map((entry) => {
			const manifest = typeof entry.dir === "string" ? readJson$1(join(entry.dir, "package.json")) : void 0;
			return {
				name: entry.name,
				...typeof manifest?.version === "string" ? { version: manifest.version } : {},
				...typeof entry.dir === "string" ? { dir: entry.dir } : {},
				...typeof entry.at === "string" ? { injectedAt: entry.at } : {}
			};
		})
	};
}
async function scanBundles(pluginManager, config, warnings, options) {
	if (pluginManager === void 0 || typeof pluginManager.listBundles !== "function") {
		warnings.push("pluginManager 不可用：套件与插件清单无法读取");
		return {
			rows: [],
			scanned: 0,
			skipped: 0
		};
	}
	let bundles = [];
	try {
		bundles = await pluginManager.listBundles() ?? [];
	} catch (error) {
		warnings.push("listBundles 失败：" + String(error));
		return {
			rows: [],
			scanned: 0,
			skipped: 0
		};
	}
	const rows = [];
	let scanned = 0;
	let skipped = 0;
	const queue = bundles.filter((bundle) => bundle !== null && typeof bundle.name === "string");
	const runOne = async (bundle) => {
		const sourceKind = classifySource(typeof bundle.source === "string" ? bundle.source : void 0);
		const base = {
			name: bundle.name,
			kind: "bundle",
			...typeof bundle.version === "string" ? { installed: bundle.version } : {},
			sourceKind,
			...typeof bundle.source === "string" ? { source: bundle.source } : {},
			enabled: bundle.enabled === true,
			updatable: bundle.updatable === true,
			status: "unknown"
		};
		if (bundle.updatable !== true) {
			if (bundle.availability === "installation" || bundle.official === true || bundle.readOnlyReason === "management-required") return {
				...base,
				status: "not-registry",
				providedByCore: true,
				detail: "DSH 安装本体自带，随本体升级"
			};
			if (!options.probe) return {
				...base,
				status: "not-registry",
				detail: "本地源（上游待查）"
			};
			const localDir = localDirOf(base.source);
			const upstream = await probeUpstream(config.registry, bundle.name, base.installed, config.timeoutMs, localDir);
			const localDelta = upstream.convertible && upstream.version !== void 0 ? await compareLocalWithUpstream({
				dir: localDir,
				name: bundle.name,
				version: upstream.version,
				tarballUrl: upstream.tarballUrl,
				timeoutMs: config.timeoutMs
			}) : void 0;
			return {
				...base,
				status: "not-registry",
				upstream,
				...localDelta === void 0 ? {} : { localDelta },
				detail: upstream.convertible && upstream.version !== void 0 ? "上游有 " + upstream.version + "，可转为线上依赖" : upstream.reason ?? "非 registry 源（本地链接 / git / 压缩包）"
			};
		}
		if (!options.probe) return {
			...base,
			status: "unknown",
			detail: "上游待查"
		};
		scanned += 1;
		/**
		* 快筛：先用 dist-tags（几十字节）判断「上游到底有没有比本地新的」。
		* 绝大多数包都是最新的，这一跳就能定案；只有真发现有新版才付 pnpm view 的代价
		* （一次 listVersions ≈ 2–4s，19 个包串下来就是二十几秒）。
		*/
		const tags = await fetchDistTags(config.registry, bundle.name, config.timeoutMs);
		if (tags !== void 0 && base.installed !== void 0) {
			const stableTag = tags.latest !== void 0 && !isPrerelease(tags.latest) ? tags.latest : void 0;
			const previewTag = tags.alpha ?? tags.next ?? tags.beta ?? tags.canary;
			const newest = [stableTag, previewTag].filter((value) => value !== void 0).sort((left, right) => compareVersions(right, left))[0];
			if (newest !== void 0 && compareVersions(newest, base.installed) <= 0) {
				const hit = (version) => version === void 0 ? void 0 : {
					version,
					tags: Object.entries(tags).filter(([, value]) => value === version).map(([key]) => key)
				};
				return {
					...base,
					...hit(stableTag) === void 0 ? {} : { stable: hit(stableTag) },
					...hit(previewTag ?? stableTag) === void 0 ? {} : { preview: hit(previewTag ?? stableTag) },
					newerCount: 0,
					status: newest === base.installed ? "latest" : "local-ahead",
					detail: "上游没有比本地更新的版本"
				};
			}
		}
		try {
			const listing = await pluginManager.listVersions(bundle.name);
			if (listing?.status !== "listed") return {
				...base,
				status: "unknown",
				detail: "上游查询被拒：" + String(listing?.problem ?? listing?.reason ?? "未知")
			};
			const published = listing.versions ?? [];
			const usable = published.filter((entry) => entry.bundle !== false && entry.incompatible === void 0);
			const channels = pickChannels(usable, (version) => {
				const found = published.find((entry) => entry.version === version);
				return found?.tags === void 0 ? [] : [...found.tags];
			});
			const status = statusOf(base.installed, channels);
			const omitted = typeof listing.omitted === "number" ? listing.omitted : 0;
			return {
				...base,
				...channels,
				newerCount: usable.length + omitted,
				status,
				...usable.length === 0 ? { detail: "上游没有比本地更新的版本" } : {}
			};
		} catch (error) {
			return {
				...base,
				status: "unknown",
				detail: "上游查询失败：" + String(error).slice(0, 200)
			};
		}
	};
	const settled = await Promise.all(queue.map((bundle) => runOne(bundle)));
	rows.push(...settled);
	skipped = bundles.length - queue.length;
	return {
		rows,
		scanned,
		skipped
	};
}
async function scanCore(config, warnings, probe = true) {
	const root = findCoreRoot();
	const manifest = root === void 0 ? void 0 : readJson$1(join(root, "package.json"));
	const version = typeof manifest?.version === "string" ? manifest.version : void 0;
	const distTags = probe ? await fetchDistTags(config.registry, "@deepseek-ai/dsh", config.timeoutMs) : void 0;
	const channels = {};
	if (distTags !== void 0) {
		const stableTag = distTags.latest;
		if (stableTag !== void 0) channels.stable = {
			version: stableTag,
			tags: Object.entries(distTags).filter(([, value]) => value === stableTag).map(([key]) => key)
		};
		const previewTag = distTags.alpha ?? distTags.next ?? distTags.beta ?? distTags.canary;
		if (previewTag !== void 0 && previewTag !== stableTag) channels.preview = {
			version: previewTag,
			tags: Object.entries(distTags).filter(([, value]) => value === previewTag).map(([key]) => key)
		};
	} else if (probe) warnings.push("npm dist-tags 查询失败：DSH 本体上游版本未知");
	const runtimeDir = coreRuntimeDir();
	return {
		name: "@deepseek-ai/dsh",
		...version === void 0 ? {} : { version },
		...root === void 0 ? {} : { root },
		...runtimeDir === void 0 ? {} : { runtimeDir },
		updatable: runtimeDir !== void 0 && version !== void 0,
		registry: config.registry,
		...distTags === void 0 ? {} : { distTags },
		channels,
		reachable: distTags !== void 0,
		status: "unknown"
	};
}
async function scan(pluginManager, config, options = {}) {
	const warnings = [];
	const partial = options.partial === true;
	const probe = !partial;
	const injections = options.injections ?? readInjections();
	const [core, bundleScan, env] = await Promise.all([
		scanCore(config, warnings, probe),
		scanBundles(pluginManager, config, warnings, { probe }),
		probeEnv(options.deep === true, config.timeoutMs)
	]);
	const injected = await Promise.all(injections.entries.map(async (entry) => {
		const upstream = probe ? await probeUpstream(config.registry, entry.name, entry.version, config.timeoutMs, entry.dir) : void 0;
		const localDelta = upstream?.convertible === true && upstream.version !== void 0 ? await compareLocalWithUpstream({
			dir: entry.dir,
			name: entry.name,
			version: upstream.version,
			tarballUrl: upstream.tarballUrl,
			timeoutMs: config.timeoutMs
		}) : void 0;
		return {
			name: entry.name,
			kind: "injected",
			...entry.version === void 0 ? {} : { installed: entry.version },
			sourceKind: "injected",
			...entry.dir === void 0 ? {} : { source: entry.dir },
			updatable: false,
			status: "not-registry",
			...upstream === void 0 ? {} : { upstream },
			...localDelta === void 0 ? {} : { localDelta },
			detail: upstream?.convertible === true && upstream.version !== void 0 ? "上游有 " + upstream.version + "，可转线上（需先解除注入）" : "运行时注入（超级注入器），更新走 dev_inject_plugin / dev_reload_package"
		};
	}));
	core.status = (() => {
		if (!core.reachable) return "unknown";
		if (core.channels.preview === void 0) return "latest";
		if (core.version === void 0) return "unknown";
		if (compareVersions(core.channels.preview.version, core.version) <= 0) return "local-ahead";
		if (core.channels.stable !== void 0 && compareVersions(core.channels.stable.version, core.version) > 0) return "update";
		return "preview-only";
	})();
	const stableUpdates = bundleScan.rows.filter((row) => row.status === "update").length + (core.channels.stable !== void 0 && core.version !== void 0 && compareVersions(core.channels.stable.version, core.version) > 0 ? 1 : 0);
	const previewUpdates = bundleScan.rows.filter((row) => row.status === "preview-only").length + (core.channels.preview !== void 0 && core.version !== void 0 && compareVersions(core.channels.preview.version, core.version) > 0 ? 1 : 0);
	const convertible = [...bundleScan.rows, ...injected].filter((row) => row.upstream?.convertible === true).length;
	return {
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		cached: false,
		registry: config.registry,
		core,
		bundles: bundleScan.rows.filter((row) => row.providedByCore !== true).sort((left, right) => left.name.localeCompare(right.name)),
		coreProvided: bundleScan.rows.filter((row) => row.providedByCore === true).sort((left, right) => left.name.localeCompare(right.name)),
		injected,
		env,
		summary: {
			stableUpdates,
			previewUpdates,
			scannedBundles: bundleScan.scanned,
			skippedBundles: bundleScan.skipped,
			convertible
		},
		...partial ? { partial: true } : {},
		warnings
	};
}
//#endregion
//#region lib/types/host/convert.js
async function convertToRegistry(manager, options) {
	const name = options.name.trim();
	if (name === "") return {
		ok: false,
		message: "缺少包名"
	};
	if (isLocalProtectedPackage(name)) return {
		ok: false,
		name,
		message: name + " 为本地自研受保护包（白名单锁定），禁止转为公共 npm 依赖"
	};
	if (manager === void 0 || typeof manager.listBundles !== "function") return {
		ok: false,
		name,
		message: "pluginManager 不可用，无法执行转换"
	};
	let row;
	try {
		row = (await manager.listBundles() ?? []).find((bundle) => bundle?.name === name);
	} catch (error) {
		return {
			ok: false,
			name,
			message: "读取套件清单失败：" + String(error)
		};
	}
	const injected = options.injected === true || row === void 0;
	if (row === void 0 && options.injected !== true) return {
		ok: false,
		name,
		message: "清单里没有 " + name + "（可能已经卸载）"
	};
	if (row !== void 0) {
		if (row.official === true || row.availability === "installation" || row.readOnlyReason === "management-required") return {
			ok: false,
			name,
			message: "这是 DSH 安装本体自带的包，随本体升级，不需要转线上"
		};
		if (row.updatable === true) return {
			ok: false,
			name,
			message: "它已经是 registry 依赖了，直接用「更新」即可"
		};
	}
	const installed = typeof row?.version === "string" ? row.version : void 0;
	const dir = options.dir ?? localDirOf(typeof row?.source === "string" ? row.source : void 0) ?? (injected ? readInjections().entries.find((entry) => entry.name === name)?.dir : void 0);
	const probeUpstreamFn = options.probeUpstreamImpl ?? probeUpstream;
	const compareLocalFn = options.compareLocalImpl ?? compareLocalWithUpstream;
	const probe = await probeUpstreamFn(options.registry, name, installed, options.timeoutMs);
	if (probe.found !== true || probe.version === void 0) return {
		ok: false,
		name,
		from: installed,
		message: probe.reason ?? "上游查不到同名包，无法转线上"
	};
	if (probe.convertible !== true) return {
		ok: false,
		name,
		from: installed,
		to: probe.version,
		message: probe.reason ?? "上游这一版不能转线上"
	};
	const requested = options.version?.trim() ?? "";
	const target = requested === "" ? probe.version : requested;
	if (target !== probe.version) return {
		ok: false,
		name,
		from: installed,
		to: target,
		message: "目标版本 " + target + " 不是上游最新版 " + probe.version + "（转换只装上游最新版）"
	};
	const localDelta = dir === void 0 || dir === "" ? void 0 : await compareLocalFn({
		dir,
		name,
		version: target,
		tarballUrl: probe.tarballUrl,
		timeoutMs: options.timeoutMs
	});
	if (localDelta !== void 0 && localDelta.status === "modified" && options.confirmOverwrite !== true) return {
		ok: false,
		name,
		from: installed,
		to: target,
		localDelta,
		message: "本地有 " + String(localDelta.changedCount ?? 0) + " 处与上游 " + target + " 不同（" + (localDelta.changedFiles ?? []).slice(0, 6).join("、") + "…）：转线上后生效的是上游版本，本地改动不再生效（本地目录不会被删除）；确认请带 confirmOverwrite=true"
	};
	if (typeof manager.installBundle !== "function") return {
		ok: false,
		name,
		message: "pluginManager 没有 installBundle，无法执行转换"
	};
	/**
	* 关键：HMR 在线时 `installBundle` 对「已经存在的依赖」会直接抛 `already-installed`
	* （见 pluginManager 源码），所以不能直接 install，必须像官方 updateBundle 那样
	* **先摘后装**，失败再把原规格装回去。原规格 = 当前那条 link:/git/tarball 字符串，
	* 所以回滚是逐字恢复，不是猜出来的。
	*/
	const previous = typeof row?.source === "string" && row.source !== "" ? row.source : `${name}@${installed ?? target}`;
	const payloadBase = {
		ok: false,
		name,
		...installed === void 0 ? {} : { from: installed },
		to: target,
		...injected ? { needsUninject: true } : {},
		...localDelta === void 0 ? {} : { localDelta }
	};
	const describe = (result) => {
		const packageResult = result?.packageResult;
		if (packageResult === void 0) return void 0;
		return {
			exitCode: Number(packageResult.exitCode ?? -1),
			...packageResult.kind === void 0 ? {} : { kind: String(packageResult.kind) },
			...typeof packageResult.output === "string" ? { output: packageResult.output.slice(-2e3) } : {},
			...typeof packageResult.logPath === "string" ? { logPath: packageResult.logPath } : {}
		};
	};
	try {
		if (!injected) {
			if (typeof manager.removeBundle !== "function") return {
				...payloadBase,
				message: "pluginManager 没有 removeBundle，无法先摘旧来源"
			};
			const removal = await manager.removeBundle(name);
			if (removal?.application === "failed" || removal?.application === "cancelled") return {
				...payloadBase,
				application: String(removal?.application ?? "failed"),
				message: "摘除旧来源失败：" + String(removal?.error?.code ?? removal?.application ?? "unknown") + (removal?.error?.diagnostic === void 0 ? "" : "（" + String(removal.error.diagnostic).slice(0, 200) + "）") + "；依赖未改动"
			};
		}
		const result = await manager.installBundle(name + "@" + target, {
			registry: options.registry,
			saveExact: false,
			enabled: true
		});
		const application = String(result?.application ?? "unknown");
		if (!(application === "applied" || application === "overridden" || application === "restart-required")) {
			let restored = false;
			if (!injected) try {
				const restore = await manager.installBundle(previous, {
					registry: options.registry,
					enabled: true
				});
				restored = restore?.application !== "failed" && restore?.application !== "cancelled";
			} catch {
				restored = false;
			}
			return {
				...payloadBase,
				application,
				message: "转线上失败：" + String(result?.error?.code ?? application) + (result?.error?.diagnostic === void 0 ? "" : "（" + String(result.error.diagnostic).slice(0, 200) + "）") + (injected ? "" : restored ? "；已恢复原来源 " + previous : "；原来源恢复失败，需要手动 pnpm add " + previous),
				...describe(result) === void 0 ? {} : { packageResult: describe(result) }
			};
		}
		const payload = {
			...payloadBase,
			ok: true,
			application,
			...result?.restartReason === void 0 ? {} : { restartReason: String(result.restartReason) },
			message: application === "restart-required" ? "已换成线上 " + target + "，但这个包要重启 DSH 才生效" : "已换成线上 " + target + "，依赖规格已改写为 registry 版本",
			...describe(result) === void 0 ? {} : { packageResult: describe(result) }
		};
		if (injected) payload.message = payload.message + "｜注意：注入的那一份还在跑，请在会话里执行 dev_uninject_plugin " + name + " 解除注入（同名插件重复注册会互相打架）";
		return payload;
	} catch (error) {
		let restored = false;
		if (!injected) try {
			const restore = await manager.installBundle(previous, {
				registry: options.registry,
				enabled: true
			});
			restored = restore?.application !== "failed" && restore?.application !== "cancelled";
		} catch {
			restored = false;
		}
		return {
			...payloadBase,
			message: "转换异常：" + String(error) + (injected ? "" : restored ? "；已恢复原来源 " + previous : "；原来源可能已摘除，请手动 pnpm add " + previous)
		};
	}
}
//#endregion
//#region lib/types/host/batch.js
var BatchRunner = class {
	deps;
	state;
	constructor(deps) {
		this.deps = deps;
	}
	current() {
		return this.state;
	}
	running() {
		return this.state?.running === true;
	}
	cancel() {
		if (this.state === void 0 || this.state.running !== true) return false;
		this.state.cancelled = true;
		return true;
	}
	/** 启动队列；立刻返回初始状态，实际执行在后台推进。 */
	start(plan, channel) {
		const items = plan.map((entry) => ({
			name: entry.name,
			...entry.from === void 0 ? {} : { from: entry.from },
			to: entry.to,
			channel: entry.channel,
			status: "pending"
		}));
		const state = {
			id: (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
			startedAt: Date.now(),
			running: true,
			cancelled: false,
			channel,
			total: items.length,
			done: 0,
			items,
			summary: {
				ok: 0,
				warn: 0,
				failed: 0,
				skipped: 0
			}
		};
		this.state = state;
		this.run(state);
		return state;
	}
	async run(state) {
		let consecutiveFailures = 0;
		for (const item of state.items) {
			if (state.cancelled) {
				item.status = "skipped";
				item.message = "已叫停";
				state.summary.skipped += 1;
				state.done += 1;
				continue;
			}
			item.status = "running";
			state.current = item.name;
			try {
				const result = await this.deps.apply(item.name, item.to);
				if (result.ok) {
					item.status = "ok";
					consecutiveFailures = 0;
				} else if (result.application === "restart-required") {
					item.status = "warn";
					consecutiveFailures = 0;
				} else {
					item.status = "failed";
					consecutiveFailures += 1;
				}
				item.message = result.message ?? "";
				if (result.application !== void 0) item.application = result.application;
				if (item.status === "ok") state.summary.ok += 1;
				else if (item.status === "warn") state.summary.warn += 1;
				else state.summary.failed += 1;
			} catch (error) {
				item.status = "failed";
				item.message = "更新异常：" + String(error);
				state.summary.failed += 1;
				consecutiveFailures += 1;
			}
			state.done += 1;
			this.deps.invalidate?.();
			this.deps.onItemDone?.(item, state);
			if (item.status === "failed" && this.deps.stopOnError || consecutiveFailures >= Math.max(1, this.deps.abortAfterConsecutiveFailures)) {
				const reason = item.status === "failed" && this.deps.stopOnError ? "前一项失败，已停止" : "连续 " + consecutiveFailures + " 项失败，疑似上游或 pnpm 异常，已停止";
				for (const rest of state.items) if (rest.status === "pending") {
					rest.status = "skipped";
					rest.message = reason;
					state.summary.skipped += 1;
					state.done += 1;
				}
				break;
			}
		}
		state.current = void 0;
		state.running = false;
		state.finishedAt = Date.now();
	}
};
//#endregion
//#region lib/types/host/state.js
/**
* 更新中心的本地状态：快照磁盘缓存 + 「装好了要重启才生效」清单。
*
* 为什么要落盘：
*   1. 一次完整扫描要跑十几次 `pnpm view`（~30s）。面板打开时才扫，用户就得干等。
*      把上一次的快照写盘，进程重启后也能先把旧数据画出来，再后台刷新。
*   2. 需要重启的包是**跨会话**的事实：更新完服务没重启，那个包就一直没生效。
*      记到盘上，面板一打开就能提醒，而不是只留在某一次请求的返回值里。
*/
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
function writeJson(path, value) {
	try {
		mkdirSync(updateCenterHome(), { recursive: true });
		writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
	} catch {}
}
function snapshotCachePath() {
	return join(updateCenterHome(), "snapshot.json");
}
function readSnapshotCache() {
	const path = snapshotCachePath();
	if (!existsSync(path)) return void 0;
	const raw = readJson(path);
	if (raw === void 0 || raw.snapshot === void 0 || raw.snapshot.core === void 0) return void 0;
	const at = typeof raw.at === "number" ? raw.at : Date.parse(String(raw.snapshot.generatedAt ?? ""));
	if (Number.isNaN(at)) return void 0;
	return {
		at,
		snapshot: raw.snapshot
	};
}
function writeSnapshotCache(snapshot) {
	if (snapshot.partial === true) return;
	writeJson(snapshotCachePath(), {
		at: Date.now(),
		snapshot
	});
}
function pendingRestartPath() {
	return join(updateCenterHome(), "pending-restart.json");
}
function readPendingRestart() {
	const raw = readJson(pendingRestartPath());
	if (raw === void 0 || raw === null || typeof raw !== "object") return { items: [] };
	return {
		items: Array.isArray(raw.items) ? raw.items.filter((item) => item !== null && typeof item === "object" && typeof item.name === "string").map((item) => ({
			name: item.name,
			at: typeof item.at === "string" ? item.at : (/* @__PURE__ */ new Date()).toISOString(),
			...typeof item.from === "string" ? { from: item.from } : {},
			...typeof item.to === "string" ? { to: item.to } : {},
			...typeof item.reason === "string" ? { reason: item.reason } : {}
		})) : [],
		...typeof raw.at === "string" ? { at: raw.at } : {},
		...typeof raw.clearedAt === "string" ? { clearedAt: raw.clearedAt } : {},
		...typeof raw.clearedBy === "string" ? { clearedBy: raw.clearedBy } : {}
	};
}
/** 记下「这个包装好了但要重启」。同名条目覆盖，不重复堆。 */
function addPendingRestart(items) {
	if (items.length === 0) return readPendingRestart();
	const next = {
		items: [...readPendingRestart().items.filter((existing) => items.every((item) => item.name !== existing.name)), ...items].slice(-50),
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	writeJson(pendingRestartPath(), next);
	return next;
}
function clearPendingRestart(by) {
	const next = {
		items: [],
		clearedAt: (/* @__PURE__ */ new Date()).toISOString(),
		clearedBy: by
	};
	writeJson(pendingRestartPath(), next);
	return next;
}
/**
* 服务重启过了就自动销账：`systemctl show -p ActiveEnterTimestamp` 晚于记录时间，
* 说明那些包已经在新进程里生效，清单不该再提醒。
*/
function settlePendingRestart(serviceSince) {
	const state = readPendingRestart();
	if (state.items.length === 0 || state.at === void 0 || serviceSince === void 0) return state;
	const since = Date.parse(serviceSince);
	const recorded = Date.parse(state.at);
	if (Number.isNaN(since) || Number.isNaN(recorded)) return state;
	if (since <= recorded + 5e3) return state;
	return clearPendingRestart("service-restarted@" + serviceSince);
}
//#endregion
//#region lib/types/host/history.js
/** 更新历史：JSONL 追加，只保留最近 N 条。面板和 agent 都能读。 */
const KEEP = 400;
function historyPath() {
	return join(updateCenterHome(), "history.jsonl");
}
function appendHistory(entry, limit = KEEP) {
	try {
		mkdirSync(updateCenterHome(), { recursive: true });
		appendFileSync(historyPath(), JSON.stringify(entry) + "\n", "utf8");
		trim(limit);
	} catch {}
}
function trim(limit) {
	try {
		const lines = readFileSync(historyPath(), "utf8").split("\n").filter((line) => line.trim() !== "");
		if (lines.length <= limit + 50) return;
		writeFileSync(historyPath(), lines.slice(-limit).join("\n") + "\n", "utf8");
	} catch {}
}
function readHistory(limit = 30) {
	const path = historyPath();
	if (!existsSync(path)) return [];
	try {
		const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
		const entries = [];
		for (const line of lines.slice(-limit)) try {
			const parsed = JSON.parse(line);
			if (parsed !== null && typeof parsed === "object" && typeof parsed.at === "string") entries.push(parsed);
		} catch {}
		return entries.reverse();
	} catch {
		return [];
	}
}
//#endregion
//#region lib/types/host/reminder.js
function parseVersion(version) {
	if (version === void 0) return void 0;
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
	if (match === null) return void 0;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] !== void 0
	};
}
/** from → to 的升级级别；to 不高于 from 返回 same。 */
function versionLevel(from, to) {
	if (from === void 0 || to === void 0) return "same";
	if (compareVersions(to, from) <= 0) return "same";
	const a = parseVersion(from);
	const b = parseVersion(to);
	if (a === void 0 || b === void 0) return "patch";
	if (b.major > a.major) return "major";
	if (a.major === 0 && b.minor > a.minor) return "major";
	if (b.minor > a.minor) return "minor";
	if (b.patch > a.patch) return "patch";
	return "prerelease";
}
function levelLabel(level) {
	switch (level) {
		case "major": return "大版本";
		case "minor": return "次版本";
		case "patch": return "补丁版";
		case "prerelease": return "预发布";
		default: return "";
	}
}
/** 从快照算出提醒。快照可能是 undefined（还没扫过）。 */
function reminderFrom(snapshot, context = {}) {
	const base = {
		hasData: snapshot !== void 0,
		scanning: context.scanning === true,
		...context.ageSeconds === void 0 ? {} : { ageSeconds: context.ageSeconds },
		core: { hasUpdate: false },
		plugins: {
			count: 0,
			previewOnly: 0,
			names: []
		},
		pendingRestart: 0,
		convertible: 0
	};
	if (snapshot === void 0) return base;
	const core = snapshot.core;
	const stableTarget = core.channels?.stable?.version;
	const previewTarget = core.channels?.preview?.version;
	const current = core.version;
	const useStable = stableTarget !== void 0 && current !== void 0 && compareVersions(stableTarget, current) > 0;
	const usePreview = !useStable && previewTarget !== void 0 && current !== void 0 && compareVersions(previewTarget, current) > 0;
	const target = useStable ? stableTarget : usePreview ? previewTarget : void 0;
	const level = target === void 0 ? "same" : versionLevel(current, target);
	const plugins = snapshot.bundles.filter((row) => row.providedByCore !== true);
	const updates = plugins.filter((row) => row.status === "update");
	const previewOnly = plugins.filter((row) => row.status === "preview-only");
	const pending = snapshot.pendingRestart ?? [];
	const convertible = [...plugins, ...snapshot.injected ?? []].filter((row) => row.upstream?.convertible === true).length;
	return {
		hasData: true,
		scanning: context.scanning === true,
		...context.ageSeconds === void 0 ? {} : { ageSeconds: context.ageSeconds },
		...snapshot.generatedAt === void 0 ? {} : { generatedAt: snapshot.generatedAt },
		core: {
			hasUpdate: target !== void 0,
			...current === void 0 ? {} : { current },
			...target === void 0 ? {} : { target },
			...target === void 0 ? {} : { channel: useStable ? "stable" : "preview" },
			...target === void 0 ? {} : { level },
			...target === void 0 ? {} : { label: levelLabel(level) }
		},
		plugins: {
			count: updates.length,
			previewOnly: previewOnly.length,
			names: updates.slice(0, 8).map((row) => row.name)
		},
		pendingRestart: pending.length,
		convertible
	};
}
//#endregion
//#region lib/types/host/infra.js
const INFRA_CACHE_PATH = join(homedir(), ".dsh", "update-center", "infra-snapshot.json");
const INFRA_CONFIG_PATH = join(homedir(), ".dsh", "update-center", "infra-config.json");
/** 默认容器保护锁名单（留空以保持开源通用性；自动检测 label / @sha256 / 无 RepoDigests 本地镜像，并支持 ~/.dsh/update-center/infra-config.json 覆盖） */
const DEFAULT_LOCKED_DOCKER_CONTAINERS = {};
/** PVE 需人工 DKMS 网卡驱动门禁的内核/虚拟化核心包前缀 */
const PVE_KERNEL_LOCKED_PREFIXES = [
	"proxmox-kernel",
	"proxmox-headers",
	"proxmox-default-kernel",
	"pve-kernel",
	"pve-headers",
	"pve-qemu-kvm",
	"qemu-server",
	"pve-manager",
	"pve-cluster",
	"pve-container",
	"pve-firewall",
	"pve-ha-manager",
	"pve-firmware",
	"proxmox-backup-restore-image",
	"proxmox-",
	"libproxmox-",
	"libpve-",
	"grub-",
	"grub2-",
	"proxmox-grub",
	"r8125",
	"dkms"
];
function isPveKernelLockedPackage(pkgName) {
	for (const prefix of PVE_KERNEL_LOCKED_PREFIXES) if (pkgName === prefix || pkgName.startsWith(prefix)) return "涉及 PVE 内核/虚拟化或引导层，受 DKMS 网卡驱动与虚拟化门禁保护，需单独维护窗口";
}
function loadInfraUserConfig() {
	try {
		if (existsSync(INFRA_CONFIG_PATH)) {
			const parsed = JSON.parse(readFileSync(INFRA_CONFIG_PATH, "utf8"));
			if (parsed && typeof parsed === "object") return parsed;
		}
	} catch {}
	return {};
}
function runCmd(cmd, args, timeoutMs = 25e3) {
	return new Promise((resolve) => {
		execFile(cmd, args, {
			timeout: timeoutMs,
			maxBuffer: 4194304
		}, (err, stdout, stderr) => {
			resolve({
				code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? "")
			});
		});
	});
}
/** 解析 ~/.ssh/config 中定义的 Host 别名，辅助自动发现常用局域网节点 */
function listSshConfigHosts() {
	const hosts = /* @__PURE__ */ new Set();
	try {
		const sshCfg = join(homedir(), ".ssh", "config");
		if (!existsSync(sshCfg)) return hosts;
		const text = readFileSync(sshCfg, "utf8");
		for (const line of text.split("\n")) {
			const m = line.trim().match(/^Host\s+(.+)$/i);
			if (!m) continue;
			for (const token of m[1].split(/\s+/)) if (token && !token.includes("*") && !token.includes("?")) hosts.add(token);
		}
	} catch {}
	return hosts;
}
/** 自动发现当前环境的 Docker 节点（本机 + 可选 SSH / PVE 节点） */
async function resolveDockerNodes() {
	const cfg = loadInfraUserConfig();
	if (Array.isArray(cfg.dockerNodes) && cfg.dockerNodes.length > 0) return cfg.dockerNodes;
	const sshHosts = listSshConfigHosts();
	const host = hostname();
	if (sshHosts.has("istoreos") && sshHosts.has("pve")) return [
		{
			id: "vm100",
			label: `VM100 (${host} 本机)`,
			mode: "local"
		},
		{
			id: "istoreos",
			label: "iStoreOS (软路由)",
			mode: "ssh",
			sshHost: "istoreos"
		},
		{
			id: "fnos",
			label: "fnOS (飞牛 NAS)",
			mode: "pve-qm",
			pveHost: "pve",
			vmid: 101
		}
	];
	return [{
		id: "local",
		label: `${host} (本机)`,
		mode: "local"
	}];
}
/** 自动发现当前环境的 APT 节点（本机 + 可选 PVE 宿主机） */
async function resolveAptNodes() {
	const cfg = loadInfraUserConfig();
	if (Array.isArray(cfg.aptNodes) && cfg.aptNodes.length > 0) return cfg.aptNodes;
	const sshHosts = listSshConfigHosts();
	const host = hostname();
	const localIsPve = existsSync("/usr/bin/pveversion");
	if (sshHosts.has("pve") && !localIsPve) return [{
		id: "vm100",
		label: `VM100 (${host} 本机)`,
		mode: "local",
		isProxmox: false,
		useSudo: true
	}, {
		id: "pve",
		label: "PVE 宿主机",
		mode: "ssh",
		sshHost: "pve",
		isProxmox: true,
		useSudo: false
	}];
	return [{
		id: localIsPve ? "pve" : "local",
		label: localIsPve ? `${host} (PVE 本机)` : `${host} (本机)`,
		mode: "local",
		isProxmox: localIsPve,
		useSudo: !localIsPve
	}];
}
const remoteDigestCache = /* @__PURE__ */ new Map();
async function getRemoteDigests(imageRef) {
	const cleanRef = imageRef.includes("@sha256:") ? imageRef.split("@sha256:")[0] : imageRef;
	if (!/^[a-zA-Z0-9._/:@-]+$/.test(cleanRef)) return { digests: /* @__PURE__ */ new Set() };
	const now = Date.now();
	const cached = remoteDigestCache.get(cleanRef);
	if (cached && now - cached.at < 6e5) return {
		digests: cached.digests,
		...cached.primary === void 0 ? {} : { primary: cached.primary }
	};
	let outText = "";
	const localBuildx = await runCmd("docker", [
		"buildx",
		"imagetools",
		"inspect",
		cleanRef
	], 12e3);
	if (localBuildx.code === 0 && localBuildx.stdout.includes("sha256:")) outText = localBuildx.stdout;
	if (!outText.includes("sha256:") && listSshConfigHosts().has("pve")) {
		const fnosRes = await runCmd("ssh", [
			"-o",
			"ConnectTimeout=5",
			"pve",
			`qm guest exec 101 -- docker buildx imagetools inspect ${cleanRef}`
		], 2e4);
		if (fnosRes.code === 0) try {
			const parsed = JSON.parse(fnosRes.stdout);
			outText = String(parsed?.["out-data"] ?? "");
		} catch {
			outText = fnosRes.stdout;
		}
	}
	if (!outText.includes("sha256:")) {
		const localRes = await runCmd("docker", [
			"manifest",
			"inspect",
			"-v",
			cleanRef
		], 15e3);
		if (localRes.code === 0) outText = localRes.stdout;
	}
	const digests = /* @__PURE__ */ new Set();
	let primary;
	if (outText) {
		const matches = outText.matchAll(/sha256:[0-9a-f]{64}/g);
		for (const m of matches) {
			if (primary === void 0) primary = m[0];
			digests.add(m[0]);
		}
	}
	remoteDigestCache.set(cleanRef, {
		at: now,
		digests,
		...primary === void 0 ? {} : { primary }
	});
	return {
		digests,
		...primary === void 0 ? {} : { primary }
	};
}
function parseContainerLines(raw) {
	const out = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.includes("||")) continue;
		const parts = trimmed.split("||");
		if (parts.length < 7) continue;
		out.push({
			name: (parts[0] ?? "").replace(/^\//, "").trim(),
			image: (parts[1] ?? "").trim(),
			statusText: (parts[2] ?? "").trim(),
			repoDigests: (parts[3] ?? "").trim(),
			composeDir: (parts[4] ?? "").trim(),
			composeService: (parts[5] ?? "").trim(),
			composeConfig: (parts[6] ?? "").trim(),
			customLock: (parts[7] ?? "").trim()
		});
	}
	return out;
}
async function execOnDockerNode(nodeCfg, script, timeoutMs = 25e3) {
	if (nodeCfg.mode === "local") return runCmd("bash", ["-c", script], timeoutMs);
	if (nodeCfg.mode === "ssh" && nodeCfg.sshHost) return runCmd("ssh", [
		"-o",
		"ConnectTimeout=6",
		nodeCfg.sshHost,
		script
	], timeoutMs);
	if (nodeCfg.mode === "pve-qm" && nodeCfg.pveHost && nodeCfg.vmid !== void 0) {
		const b64 = Buffer.from(script, "utf8").toString("base64");
		const r = await runCmd("ssh", [
			"-o",
			"ConnectTimeout=6",
			nodeCfg.pveHost,
			`qm guest exec ${nodeCfg.vmid} -- bash -c "echo ${b64} | base64 -d | bash"`
		], timeoutMs);
		if (r.code === 0) try {
			const parsed = JSON.parse(r.stdout);
			return {
				code: typeof parsed?.exitcode === "number" ? parsed.exitcode : 0,
				stdout: String(parsed?.["out-data"] ?? ""),
				stderr: String(parsed?.["err-data"] ?? "")
			};
		} catch {
			return r;
		}
		return r;
	}
	return {
		code: 1,
		stdout: "",
		stderr: `Unsupported node mode: ${nodeCfg.mode}`
	};
}
async function collectNodeContainers(nodeCfg) {
	const res = await execOnDockerNode(nodeCfg, [
		`ver=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable)`,
		`echo "ENGINE:$ver"`,
		`for cid in $(docker ps -q 2>/dev/null); do`,
		`  name=$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null)`,
		`  cimg=$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null)`,
		`  st=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)`,
		`  img=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null)`,
		`  rd=$(docker image inspect -f '{{json .RepoDigests}}' "$img" 2>/dev/null)`,
		`  wdir=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$cid" 2>/dev/null)`,
		`  svc=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid" 2>/dev/null)`,
		`  cfg=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$cid" 2>/dev/null)`,
		`  lck=$(docker inspect -f '{{index .Config.Labels "dsh.update-center.lock"}}' "$cid" 2>/dev/null)`,
		`  echo "\${name}||\${cimg}||\${st}||\${rd}||\${wdir}||\${svc}||\${cfg}||\${lck}"`,
		`done`
	].join("\n"), 25e3);
	let engine = "unavailable";
	for (const line of res.stdout.split("\n")) if (line.startsWith("ENGINE:")) engine = line.slice(7).trim();
	return {
		engine,
		rows: parseContainerLines(res.stdout)
	};
}
function extractDigest(text) {
	const m = text.match(/sha256:[0-9a-f]{64}/);
	return m ? m[0] : void 0;
}
function shortDigest(d) {
	if (!d) return void 0;
	return d.replace(/^sha256:/, "").slice(0, 12);
}
/** 自动判定容器是否应被锁定保护（配置名单 + label + @sha256 钉死 + 本地构建无 RepoDigests） */
function detectContainerLockReason(nodeId, raw, userLocks) {
	const key = `${nodeId}:${raw.name}`;
	if (userLocks[key]) return userLocks[key];
	if (userLocks[raw.name]) return userLocks[raw.name];
	if (DEFAULT_LOCKED_DOCKER_CONTAINERS[key]) return DEFAULT_LOCKED_DOCKER_CONTAINERS[key];
	if (DEFAULT_LOCKED_DOCKER_CONTAINERS[raw.name]) return DEFAULT_LOCKED_DOCKER_CONTAINERS[raw.name];
	if (raw.customLock && raw.customLock !== "<no value>") return raw.customLock;
	if (raw.image.includes("@sha256:")) return "容器已通过 @sha256 摘要显式固定版本，自动锁定防止破坏上游版本约束";
	if (!extractDigest(raw.repoDigests)) return "本地构建镜像（无远端 Registry RepoDigests），自动锁定防止误拉取覆盖";
}
async function scanAllDocker() {
	const nodes = await resolveDockerNodes();
	const userLocks = loadInfraUserConfig().lockedDockerContainers ?? {};
	const collected = await Promise.all(nodes.map((n) => collectNodeContainers(n)));
	const engines = {};
	const containers = [];
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		const data = collected[i];
		engines[n.id] = data.engine;
		for (const raw of data.rows) {
			const lockReason = detectContainerLockReason(n.id, raw, userLocks);
			const localFull = extractDigest(raw.repoDigests) ?? extractDigest(raw.image);
			const localShort = shortDigest(localFull);
			if (lockReason !== void 0) {
				containers.push({
					node: n.id,
					nodeLabel: n.label,
					name: raw.name,
					image: raw.image,
					statusText: raw.statusText,
					...localShort === void 0 ? {} : { localDigest: localShort },
					...raw.composeDir ? { composeDir: raw.composeDir } : {},
					...raw.composeService ? { composeService: raw.composeService } : {},
					...raw.composeConfig ? { composeConfig: raw.composeConfig } : {},
					status: "locked",
					lockReason,
					detail: lockReason
				});
				continue;
			}
			const remote = await getRemoteDigests(raw.image);
			const remoteShort = shortDigest(remote.primary);
			if (remote.digests.size === 0 || localFull === void 0) {
				containers.push({
					node: n.id,
					nodeLabel: n.label,
					name: raw.name,
					image: raw.image,
					statusText: raw.statusText,
					...localShort === void 0 ? {} : { localDigest: localShort },
					...raw.composeDir ? { composeDir: raw.composeDir } : {},
					...raw.composeService ? { composeService: raw.composeService } : {},
					...raw.composeConfig ? { composeConfig: raw.composeConfig } : {},
					status: "error",
					detail: "无法查询上游镜像摘要"
				});
				continue;
			}
			const isUpToDate = remote.digests.has(localFull);
			containers.push({
				node: n.id,
				nodeLabel: n.label,
				name: raw.name,
				image: raw.image,
				statusText: raw.statusText,
				...localShort === void 0 ? {} : { localDigest: localShort },
				...remoteShort === void 0 ? {} : { remoteDigest: remoteShort },
				...raw.composeDir ? { composeDir: raw.composeDir } : {},
				...raw.composeService ? { composeService: raw.composeService } : {},
				...raw.composeConfig ? { composeConfig: raw.composeConfig } : {},
				status: isUpToDate ? "latest" : "update",
				detail: isUpToDate ? "已与上游镜像摘要一致" : `有新镜像层 (${localShort} → ${remoteShort})`
			});
		}
	}
	return {
		engines,
		containers,
		updatableCount: containers.filter((c) => c.status === "update").length,
		lockedCount: containers.filter((c) => c.status === "locked").length
	};
}
function parseAptListOutput(nodeId, nodeLabel, isProxmox, stdout) {
	const rows = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("Listing...") || trimmed.startsWith("正在列表") || !trimmed.includes("/")) continue;
		const m = trimmed.match(/^([^\s/]+)\/\S+\s+(\S+)\s+\S+\s+\[(?:upgradable from:|可从该版本升级[：:])\s*([^\]]+)\]/);
		if (!m) continue;
		const name = m[1];
		const candidate = m[2];
		const installed = m[3].trim();
		const lockReason = isProxmox ? isPveKernelLockedPackage(name) : void 0;
		rows.push({
			node: nodeId,
			nodeLabel,
			name,
			installed,
			candidate,
			locked: lockReason !== void 0,
			...lockReason === void 0 ? {} : { lockReason }
		});
	}
	return rows;
}
async function scanAllApt() {
	const aptNodes = await resolveAptNodes();
	const nodeSummaries = await Promise.all(aptNodes.map(async (n) => {
		const cmdRes = n.mode === "local" ? await runCmd("bash", ["-c", "LC_ALL=C apt list --upgradable 2>/dev/null"], 15e3) : await runCmd("ssh", [
			"-o",
			"ConnectTimeout=5",
			n.sshHost ?? n.id,
			"LC_ALL=C apt list --upgradable 2>/dev/null"
		], 15e3);
		const pkgs = parseAptListOutput(n.id, n.label, n.isProxmox === true, cmdRes.stdout);
		return {
			node: n.id,
			label: n.label,
			...n.isProxmox !== void 0 ? { isProxmox: n.isProxmox } : {},
			packages: pkgs,
			safeUpdatableCount: pkgs.filter((p) => !p.locked).length,
			lockedCount: pkgs.filter((p) => p.locked).length
		};
	}));
	const all = nodeSummaries.flatMap((s) => s.packages);
	return {
		vm100: nodeSummaries.find((s) => s.node === "vm100" || s.node === "local")?.packages ?? nodeSummaries.find((s) => !s.isProxmox)?.packages ?? [],
		pve: nodeSummaries.find((s) => s.node === "pve" || s.isProxmox)?.packages ?? [],
		nodes: nodeSummaries,
		safeUpdatableCount: all.filter((p) => !p.locked).length,
		lockedCount: all.filter((p) => p.locked).length
	};
}
let cachedInfra;
function readCachedInfraSnapshot() {
	if (cachedInfra !== void 0) return cachedInfra;
	try {
		if (existsSync(INFRA_CACHE_PATH)) {
			cachedInfra = JSON.parse(readFileSync(INFRA_CACHE_PATH, "utf8"));
			return cachedInfra;
		}
	} catch {}
}
async function scanInfra(options = {}) {
	if (!options.refresh) {
		const cached = readCachedInfraSnapshot();
		if (cached !== void 0 && cached.toolchain !== void 0 && cached.venvs !== void 0) return cached;
	}
	remoteDigestCache.clear();
	const [docker, apt, toolchain, venvs] = await Promise.all([
		scanAllDocker(),
		scanAllApt(),
		scanAllToolchain(),
		scanAllVenvs()
	]);
	const snapshot = {
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		docker,
		apt,
		toolchain,
		venvs
	};
	cachedInfra = snapshot;
	try {
		mkdirSync(dirname(INFRA_CACHE_PATH), { recursive: true });
		writeFileSync(INFRA_CACHE_PATH, JSON.stringify(snapshot, null, 2), "utf8");
	} catch {}
	return snapshot;
}
async function fetchJson(url, timeoutMs = 6e3) {
	const res = await runCmd("curl", [
		"-s",
		"-L",
		"--max-time",
		String(Math.ceil(timeoutMs / 1e3)),
		url
	], timeoutMs + 2e3);
	if (res.code !== 0 || !res.stdout.trim()) return void 0;
	try {
		return JSON.parse(res.stdout);
	} catch {
		return;
	}
}
async function resolveUvBin() {
	const localUv = join(homedir(), ".local", "bin", "uv");
	if (existsSync(localUv)) return localUv;
	return (await runCmd("bash", ["-lc", "command -v uv"], 3e3)).stdout.trim() || localUv;
}
/** 自动扫描 ~/.local/lib/node_modules 下安装的所有顶层 npm CLI 包（排除 .retired 归档目录与隐藏目录） */
function discoverGlobalNpmPackages() {
	const root = join(homedir(), ".local", "lib", "node_modules");
	if (!existsSync(root)) return [];
	const out = [];
	const inspectPkg = (pkgName, dirPath) => {
		if (pkgName.includes(".retired")) return;
		const pkgJsonPath = join(dirPath, "package.json");
		if (!existsSync(pkgJsonPath)) return;
		try {
			const meta = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
			if (!meta?.bin) return;
			const desc = typeof meta?.description === "string" && meta.description.trim() ? meta.description.trim().slice(0, 38) : void 0;
			out.push({
				id: `npm:${pkgName}`,
				pkgName,
				label: desc ? `${pkgName} (${desc})` : pkgName,
				pkgJsonPath
			});
		} catch {}
	};
	try {
		for (const entry of readdirSync(root)) {
			if (entry.startsWith(".")) continue;
			const full = join(root, entry);
			if (!statSync(full).isDirectory()) continue;
			if (entry.startsWith("@")) for (const sub of readdirSync(full)) {
				if (sub.startsWith(".")) continue;
				const subFull = join(full, sub);
				if (statSync(subFull).isDirectory()) inspectPkg(`${entry}/${sub}`, subFull);
			}
			else inspectPkg(entry, full);
		}
	} catch {}
	return out;
}
async function scanAllToolchain() {
	const items = [];
	const uvBin = await resolveUvBin();
	const uvLocalRes = await runCmd(uvBin, ["--version"], 5e3);
	if (uvLocalRes.code === 0 && uvLocalRes.stdout.trim()) {
		const uvInstalled = uvLocalRes.stdout.trim().match(/uv\s+([0-9.]+)/)?.[1] ?? "unknown";
		const uvGithub = await fetchJson("https://api.github.com/repos/astral-sh/uv/releases/latest");
		const uvLatest = typeof uvGithub?.tag_name === "string" ? uvGithub.tag_name.replace(/^v/, "") : void 0;
		items.push({
			id: "uv",
			name: "uv (Python 极速包与虚拟环境管理)",
			category: "cli",
			installed: uvInstalled,
			...uvLatest ? { latest: uvLatest } : {},
			status: uvLatest && uvInstalled !== "unknown" && uvLatest !== uvInstalled ? "update" : "latest",
			detail: `${uvBin} (uv self update)`
		});
		const uvToolRes = await runCmd(uvBin, ["tool", "list"], 8e3);
		if (uvToolRes.code === 0) {
			const toolMatches = [...uvToolRes.stdout.matchAll(/^([a-zA-Z0-9._-]+)\s+v([0-9a-zA-Z.+_-]+)/gm)];
			await Promise.all(toolMatches.map(async (m) => {
				const toolName = m[1];
				const toolVer = m[2];
				const toolPy = join(homedir(), ".local", "share", "uv", "tools", toolName, "bin", "python");
				let latest;
				if (existsSync(toolPy)) {
					const outRes = await runCmd(uvBin, [
						"pip",
						"list",
						"--outdated",
						"--format=json",
						"--python",
						toolPy
					], 1e4);
					try {
						latest = JSON.parse(outRes.stdout).find((x) => x.name.toLowerCase() === toolName.toLowerCase())?.latest_version ?? toolVer;
					} catch {}
				}
				if (!latest) {
					const pypi = await fetchJson(`https://pypi.org/pypi/${toolName}/json`);
					latest = typeof pypi?.info?.version === "string" ? pypi.info.version : void 0;
				}
				items.push({
					id: toolName === "litellm" ? "litellm" : `uv-tool:${toolName}`,
					name: `${toolName} (uv tool 独立环境)`,
					category: "uv-tool",
					installed: toolVer,
					...latest ? { latest } : {},
					status: latest && latest !== toolVer ? "update" : "latest",
					detail: `uv tool upgrade ${toolName}`
				});
			}));
		}
	}
	const pnpmBin = existsSync("/usr/bin/pnpm") ? "/usr/bin/pnpm" : "pnpm";
	const pnpmLocalRes = await runCmd(pnpmBin, ["--version"], 5e3);
	if (pnpmLocalRes.code === 0 && pnpmLocalRes.stdout.trim()) {
		const pnpmInstalled = pnpmLocalRes.stdout.trim();
		const pnpmRegistry = await fetchJson("https://registry.npmjs.org/pnpm/latest");
		const pnpmLatest = typeof pnpmRegistry?.version === "string" ? pnpmRegistry.version : void 0;
		items.push({
			id: "pnpm",
			name: "pnpm (Node 包管理器)",
			category: "cli",
			installed: pnpmInstalled,
			...pnpmLatest ? { latest: pnpmLatest } : {},
			status: pnpmLatest && pnpmInstalled !== "unknown" && pnpmLatest !== pnpmInstalled ? "update" : "latest",
			detail: existsSync(join(homedir(), ".local", "bin", "pnpm")) ? "/usr/local/lib/pnpm-<ver>/pnpm + ~/.local/bin/pnpm 内存护栏" : pnpmBin
		});
	}
	const discoveredNpm = discoverGlobalNpmPackages();
	await Promise.all(discoveredNpm.map(async (entry) => {
		let installed = "unknown";
		try {
			installed = JSON.parse(readFileSync(entry.pkgJsonPath, "utf8")).version ?? "unknown";
		} catch {}
		const reg = await fetchJson(`https://registry.npmjs.org/${entry.pkgName}/latest`);
		const latest = typeof reg?.version === "string" ? reg.version : void 0;
		items.push({
			id: entry.id,
			name: entry.label,
			category: "npm-global",
			installed,
			...latest ? { latest } : {},
			status: latest && installed !== "unknown" && latest !== installed ? "update" : "latest",
			detail: `~/.local/lib/node_modules/${entry.pkgName}`
		});
	}));
	try {
		const optDir = join(homedir(), ".local", "opt");
		if (existsSync(optDir)) {
			const dirs = readdirSync(optDir).filter((d) => d.startsWith("Obsidian-AppImage-")).map((d) => d.replace("Obsidian-AppImage-", "")).sort((a, b) => a.localeCompare(b, void 0, { numeric: true }));
			if (dirs.length > 0) {
				const obsidianInstalled = dirs[dirs.length - 1];
				const obsGithub = await fetchJson("https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest");
				const obsLatest = typeof obsGithub?.tag_name === "string" ? obsGithub.tag_name.replace(/^v/, "") : void 0;
				items.push({
					id: "obsidian",
					name: "Obsidian 桌面端 (AppImage 解压版)",
					category: "desktop",
					installed: obsidianInstalled,
					...obsLatest ? { latest: obsLatest } : {},
					status: obsLatest && obsLatest !== obsidianInstalled ? "update" : "latest",
					detail: "~/.local/opt/Obsidian-AppImage-<ver> (不触碰 .obsidian/)"
				});
			}
		}
	} catch {}
	return {
		items,
		updatableCount: items.filter((i) => i.status === "update").length
	};
}
async function updateToolchainItem(id) {
	const uvBin = await resolveUvBin();
	if (id === "uv") {
		const res = await runCmd(uvBin, ["self", "update"], 12e4);
		return {
			ok: res.code === 0,
			message: res.code === 0 ? "uv 已自升级至最新版本" : `uv 升级失败 (exit ${res.code})`,
			output: (res.stdout + "\n" + res.stderr).trim().slice(-1500)
		};
	}
	if (id === "litellm" || id.startsWith("uv-tool:")) {
		const toolName = id === "litellm" ? "litellm" : id.slice(8);
		if (!/^[a-zA-Z0-9._-]+$/.test(toolName)) return {
			ok: false,
			message: `非法 uv tool 名称: ${toolName}`
		};
		const res = await runCmd(uvBin, [
			"tool",
			"upgrade",
			toolName
		], 18e4);
		return {
			ok: res.code === 0,
			message: res.code === 0 ? `${toolName} (uv tool) 已升级至最新版本` : `${toolName} 升级失败 (exit ${res.code})`,
			output: (res.stdout + "\n" + res.stderr).trim().slice(-1500)
		};
	}
	if (id === "pnpm") {
		const reg = await fetchJson("https://registry.npmjs.org/pnpm/latest");
		const ver = typeof reg?.version === "string" ? reg.version : "";
		if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(ver)) return {
			ok: false,
			message: "无法获取上游 pnpm 最新版本号"
		};
		const res = await runCmd("bash", ["-c", `set -e
TARGET_DIR="/usr/local/lib/pnpm-${ver}"
sudo mkdir -p "$TARGET_DIR"
curl -fsSL "https://github.com/pnpm/pnpm/releases/download/v${ver}/pnpm-linux-x64.tar.gz" | sudo tar -xz -C "$TARGET_DIR"
sudo chmod +x "$TARGET_DIR/pnpm"
sudo ln -sfn "$TARGET_DIR/pnpm" /usr/bin/pnpm
/usr/bin/pnpm --version`], 18e4);
		return {
			ok: res.code === 0,
			message: res.code === 0 ? `pnpm 已安全升级至 v${ver}` : `pnpm 升级失败 (exit ${res.code})`,
			output: (res.stdout + "\n" + res.stderr).trim().slice(-1500)
		};
	}
	if (id === "obsidian") {
		const obsGithub = await fetchJson("https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest");
		const ver = typeof obsGithub?.tag_name === "string" ? obsGithub.tag_name.replace(/^v/, "") : "";
		if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(ver)) return {
			ok: false,
			message: "无法获取上游 Obsidian 最新版本号"
		};
		const res = await runCmd("bash", ["-c", `set -e
DEST="$HOME/.local/opt/Obsidian-AppImage-${ver}"
mkdir -p "$DEST"
curl -fsSL "https://github.com/obsidianmd/obsidian-releases/releases/download/v${ver}/obsidian-${ver}.tar.gz" | tar -xz --strip-components=1 -C "$DEST"
chmod +x "$DEST/obsidian"
DESKTOP="$HOME/.local/share/applications/obsidian-appimage.desktop"
if [ -f "$DESKTOP" ]; then
  sed -i "s|Obsidian-AppImage-[0-9.]*|Obsidian-AppImage-${ver}|g" "$DESKTOP"
fi
echo "Obsidian ${ver} installed to $DEST"`], 24e4);
		return {
			ok: res.code === 0,
			message: res.code === 0 ? `Obsidian 已升级至 v${ver} 并更新桌面启动器（未触碰 .obsidian/）` : `Obsidian 升级失败 (exit ${res.code})`,
			output: (res.stdout + "\n" + res.stderr).trim().slice(-1500)
		};
	}
	if (id.startsWith("npm:")) {
		const pkgName = id.slice(4);
		if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkgName)) return {
			ok: false,
			message: `非法 npm 包名: ${pkgName}`
		};
		const reg = await fetchJson(`https://registry.npmjs.org/${pkgName}/latest`);
		const tarball = reg?.dist?.tarball;
		const latestVer = reg?.version;
		if (typeof tarball !== "string" || typeof latestVer !== "string") return {
			ok: false,
			message: `无法获取 ${pkgName} 的最新 tarball 地址`
		};
		const targetDir = join(homedir(), ".local", "lib", "node_modules", pkgName);
		const res = await runCmd("bash", ["-c", `set -e
TMP_DIR=$(mktemp -d)
trap "rm -rf '$TMP_DIR'" EXIT
curl -fsSL "${tarball}" | tar -xz -C "$TMP_DIR"
mkdir -p "${dirname(targetDir)}"
if [ -d "${targetDir}/node_modules" ]; then
  cp -a "${targetDir}/node_modules" "$TMP_DIR/package/" 2>/dev/null || true
fi
rm -rf "${targetDir}"
mv "$TMP_DIR/package" "${targetDir}"
cd "${targetDir}"
if [ -f package.json ]; then
  (command -v pnpm >/dev/null 2>&1 && pnpm install --prod --ignore-scripts --no-lockfile) || ~/.local/bin/pnpm install --prod --ignore-scripts --no-lockfile 2>&1 || true
fi
echo "Updated ${pkgName} to ${latestVer}"`], 24e4);
		return {
			ok: res.code === 0,
			message: res.code === 0 ? `全局 CLI 工具 ${pkgName} 已升级至 v${latestVer}` : `${pkgName} 升级失败 (exit ${res.code})`,
			output: (res.stdout + "\n" + res.stderr).trim().slice(-1500)
		};
	}
	return {
		ok: false,
		message: `未知的工具链条目: ${id}`
	};
}
function extractProjectSummary(projectDir, fallbackName) {
	const pyproject = join(projectDir, "pyproject.toml");
	if (existsSync(pyproject)) try {
		const m = readFileSync(pyproject, "utf8").match(/^\s*description\s*=\s*["']([^"']+)["']/m);
		if (m?.[1]?.trim()) return `${fallbackName} (${m[1].trim().slice(0, 36)})`;
	} catch {}
	for (const readmeName of ["README.zh-CN.md", "README.md"]) {
		const rp = join(projectDir, readmeName);
		if (existsSync(rp)) try {
			const h1 = readFileSync(rp, "utf8").match(/^#\s+(.+)$/m)?.[1]?.trim();
			if (h1 && h1.toLowerCase() !== fallbackName.toLowerCase()) return `${fallbackName} (${h1.slice(0, 32)})`;
		} catch {}
	}
	return fallbackName;
}
/**
* 自动扫描本机工作区下的所有 Python 虚拟环境（`<project>/.venv` 或 `<project>/venv`）：
* - 若 `~/.dsh/update-center/infra-config.json` 显式配置了 `venvProjects`，优先合并使用；
* - 否则自动扫描 `~/Projects`、`~/workspace`、`~/code`、`~/dev`、`~/repos` 及当前工作目录。
*/
function discoverProjectVenvs() {
	const cfg = loadInfraUserConfig();
	if (Array.isArray(cfg.venvProjects) && cfg.venvProjects.length > 0) return cfg.venvProjects;
	const home = homedir();
	const roots = cfg.venvSearchRoots ?? [
		join(home, "Projects"),
		join(home, "projects"),
		join(home, "workspace"),
		join(home, "code"),
		join(home, "dev"),
		join(home, "repos"),
		process.cwd()
	];
	const seenPaths = /* @__PURE__ */ new Set();
	const seenIds = /* @__PURE__ */ new Set();
	const out = [];
	const checkProjectDir = (projDir) => {
		for (const venvDirName of [".venv", "venv"]) {
			const vPath = resolve(projDir, venvDirName);
			const pyBin = join(vPath, "bin", "python");
			if (!existsSync(pyBin) || seenPaths.has(vPath)) continue;
			seenPaths.add(vPath);
			const baseId = basename(projDir);
			const id = seenIds.has(baseId) ? `${basename(dirname(projDir))}-${baseId}` : baseId;
			seenIds.add(id);
			out.push({
				id,
				project: extractProjectSummary(projDir, baseId),
				venvPath: vPath
			});
		}
	};
	for (const root of roots) {
		if (!existsSync(root)) continue;
		try {
			if (!statSync(root).isDirectory()) continue;
			checkProjectDir(root);
			for (const child of readdirSync(root)) {
				if (child.startsWith(".") || child === "node_modules") continue;
				const childFull = join(root, child);
				try {
					if (statSync(childFull).isDirectory()) checkProjectDir(childFull);
				} catch {}
			}
		} catch {}
	}
	return out;
}
function isMajorBump(installed, latest) {
	const m1 = installed.match(/^(\d+)\./);
	const m2 = latest.match(/^(\d+)\./);
	if (!m1 || !m2) return false;
	if (Number(m1[1]) >= 2020 && Number(m2[1]) >= 2020) return false;
	return m1[1] !== m2[1];
}
async function scanAllVenvs() {
	const uvBin = await resolveUvBin();
	const discovered = discoverProjectVenvs();
	const userCfg = loadInfraUserConfig();
	const projects = [];
	for (const cfg of discovered) {
		const pyBin = join(cfg.venvPath, "bin", "python");
		if (!existsSync(pyBin)) continue;
		const [pyVerRes, allInstalledRes, outdatedRes] = await Promise.all([
			runCmd(pyBin, ["--version"], 5e3),
			existsSync(uvBin) ? runCmd(uvBin, [
				"pip",
				"list",
				"--format=json",
				"--python",
				pyBin
			], 15e3) : runCmd(pyBin, [
				"-m",
				"pip",
				"list",
				"--format=json"
			], 2e4),
			existsSync(uvBin) ? runCmd(uvBin, [
				"pip",
				"list",
				"--outdated",
				"--format=json",
				"--python",
				pyBin
			], 2e4) : runCmd(pyBin, [
				"-m",
				"pip",
				"list",
				"--outdated",
				"--format=json"
			], 25e3)
		]);
		const pythonVersion = pyVerRes.stdout.trim().replace(/^Python\s+/, "") || "unknown";
		let allList = [];
		let rawList = [];
		try {
			allList = JSON.parse(allInstalledRes.stdout);
		} catch {}
		try {
			rawList = JSON.parse(outdatedRes.stdout);
		} catch {}
		const sameMajorCandidates = rawList.filter((item) => !isMajorBump(item.version, item.latest_version));
		const outdatedNames = new Set(rawList.map((item) => item.name));
		const fixedPins = allList.filter((item) => !outdatedNames.has(item.name)).map((item) => `${item.name}==${item.version}`);
		const autoConflictReasons = {};
		if (existsSync(uvBin) && sameMajorCandidates.length > 0) await Promise.all(sameMajorCandidates.map(async (cand) => {
			if ((await runCmd(uvBin, [
				"pip",
				"install",
				"--dry-run",
				"--python",
				pyBin,
				...fixedPins,
				`${cand.name}==${cand.latest_version}`
			], 1e4)).code !== 0) autoConflictReasons[cand.name] = `受虚拟环境内已安装依赖的版本上限约束（当前兼容上限 ${cand.version}），已自动锁定`;
		}));
		const customPinned = {
			...userCfg.venvPinnedPackages?.["*"] ?? {},
			...userCfg.venvPinnedPackages?.[cfg.id] ?? {}
		};
		const packages = rawList.map((item) => {
			const major = isMajorBump(item.version, item.latest_version);
			const pinReason = customPinned[item.name] ?? autoConflictReasons[item.name];
			const isLocked = major || Boolean(pinReason);
			return {
				name: item.name,
				installed: item.version,
				latest: item.latest_version,
				safe: !isLocked,
				...isLocked ? { lockReason: pinReason ?? `跨主版本 (${item.version} → ${item.latest_version})，为防 API 破坏性变更已锁定` } : {}
			};
		});
		projects.push({
			id: cfg.id,
			project: cfg.project,
			venvPath: cfg.venvPath,
			pythonVersion,
			outdatedCount: packages.length,
			safeUpdatableCount: packages.filter((p) => p.safe).length,
			packages
		});
	}
	return {
		projects,
		totalSafeUpdatable: projects.reduce((acc, p) => acc + p.safeUpdatableCount, 0)
	};
}
async function updateProjectVenv(projectId) {
	const proj = (await scanAllVenvs()).projects.find((p) => p.id === projectId);
	if (!proj) return {
		ok: false,
		message: `未找到项目虚拟环境: ${projectId}`,
		updatedPackages: []
	};
	const safePkgs = proj.packages.filter((p) => p.safe).map((p) => p.name);
	if (safePkgs.length === 0) return {
		ok: true,
		message: `项目 ${projectId} 当前没有待升级的同主版本安全包`,
		updatedPackages: []
	};
	const uvBin = await resolveUvBin();
	const pyBin = join(proj.venvPath, "bin", "python");
	const res = existsSync(uvBin) ? await runCmd(uvBin, [
		"pip",
		"install",
		"-U",
		"--python",
		pyBin,
		...safePkgs
	], 24e4) : await runCmd(pyBin, [
		"-m",
		"pip",
		"install",
		"-U",
		...safePkgs
	], 24e4);
	const ok = res.code === 0;
	return {
		ok,
		message: ok ? `项目 ${projectId} 已安全升级 ${safePkgs.length} 个依赖包（${safePkgs.join(", ")}）` : `项目 ${projectId} 依赖升级失败 (exit ${res.code})`,
		updatedPackages: ok ? safePkgs : [],
		output: (res.stdout + "\n" + res.stderr).trim().slice(-2e3)
	};
}
async function updateDockerContainer(node, name) {
	const key = `${node}:${name}`;
	const userCfg = loadInfraUserConfig();
	const lockMsg = userCfg.lockedDockerContainers?.[key] ?? userCfg.lockedDockerContainers?.[name] ?? DEFAULT_LOCKED_DOCKER_CONTAINERS[key] ?? DEFAULT_LOCKED_DOCKER_CONTAINERS[name];
	if (lockMsg !== void 0) return {
		ok: false,
		message: `拒绝更新受保护容器 ${key}：${lockMsg}`
	};
	const row = (readCachedInfraSnapshot() ?? await scanInfra({ refresh: true })).docker.containers.find((c) => c.node === node && c.name === name);
	if (!row) return {
		ok: false,
		message: `未找到容器 ${key}`
	};
	if (row.status === "locked") return {
		ok: false,
		message: `容器 ${key} 已锁定：${row.lockReason ?? "禁止更新"}`
	};
	const nodeCfg = (await resolveDockerNodes()).find((n) => n.id === node);
	if (!nodeCfg) return {
		ok: false,
		message: `未找到 Docker 节点配置: ${node}`
	};
	let script = "";
	const customRecreate = userCfg.standaloneDockerRecreate?.[key] ?? userCfg.standaloneDockerRecreate?.[name];
	if (customRecreate) script = customRecreate;
	else if (row.composeDir && row.composeService) {
		const cfgFlag = row.composeConfig && row.composeConfig.includes("/") ? `-f "${row.composeConfig.split(",")[0]}"` : "";
		script = `cd "${row.composeDir}" && (docker compose ${cfgFlag} pull "${row.composeService}" && docker compose ${cfgFlag} up -d "${row.composeService}" || (docker-compose ${cfgFlag} pull "${row.composeService}" && docker-compose ${cfgFlag} up -d "${row.composeService}")) && docker image prune -f`;
	} else return {
		ok: false,
		message: `容器 ${key} 无 docker-compose 元数据且未配置 standaloneDockerRecreate 规则，出于安全拒绝盲目重建`
	};
	const res = await execOnDockerNode(nodeCfg, script, 36e4);
	const ok = res.code === 0;
	return {
		ok,
		message: ok ? `${nodeCfg.label} 容器 ${name} 更新并清理旧层完成` : `容器 ${name} 更新失败 (exit ${res.code})`,
		output: (res.stdout + "\n" + res.stderr).trim().slice(-2e3)
	};
}
async function updateSafeApt(node) {
	const snap = await scanInfra({ refresh: true });
	const aptNodes = await resolveAptNodes();
	const nodeCfg = aptNodes.find((n) => n.id === node) ?? (node === "vm100" ? aptNodes.find((n) => n.id === "local") : void 0);
	if (!nodeCfg) return {
		ok: false,
		message: `未找到 APT 节点: ${node}`,
		updatedPackages: []
	};
	const nodeSummary = snap.apt.nodes?.find((s) => s.node === nodeCfg.id);
	const safePkgs = (nodeSummary ? nodeSummary.packages : node === "pve" ? snap.apt.pve : snap.apt.vm100).filter((p) => !p.locked).map((p) => p.name);
	if (safePkgs.length === 0) return {
		ok: true,
		message: `${nodeCfg.label} 当前没有需要更新的安全软件包`,
		updatedPackages: []
	};
	for (const pkg of safePkgs) {
		if (!/^[a-zA-Z0-9.+_-]+$/.test(pkg)) return {
			ok: false,
			message: `非法包名: ${pkg}`,
			updatedPackages: []
		};
		if (nodeCfg.isProxmox && isPveKernelLockedPackage(pkg) !== void 0) return {
			ok: false,
			message: `拦截受保护 PVE 包: ${pkg}`,
			updatedPackages: []
		};
	}
	const pkgArgs = safePkgs.join(" ");
	const aptCmd = `${nodeCfg.useSudo ? "sudo " : ""}DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade --no-install-recommends -y ${pkgArgs}`;
	const res = nodeCfg.mode === "local" ? await runCmd("bash", ["-c", aptCmd], 36e4) : await runCmd("ssh", [
		"-o",
		"ConnectTimeout=10",
		nodeCfg.sshHost ?? nodeCfg.id,
		aptCmd
	], 36e4);
	const ok = res.code === 0;
	return {
		ok,
		message: ok ? `${nodeCfg.label} 已完成 ${safePkgs.length} 个安全包更新（${safePkgs.join(", ")}）` : `${nodeCfg.label} APT 更新失败 (exit ${res.code})`,
		updatedPackages: ok ? safePkgs : [],
		output: (res.stdout + "\n" + res.stderr).trim().slice(-2e3)
	};
}
//#endregion
//#region lib/types/index.js
const name = "@dsh-external/dsh-update-center";
const inject = [];
const Config = z.object({
	registry: z.string().default("https://registry.npmjs.org"),
	cacheSeconds: z.number().min(0).default(120),
	timeoutMs: z.number().min(1e3).default(8e3),
	serviceName: z.string().default("dsh.service"),
	healthUrl: z.string().default("http://127.0.0.1:3080/"),
	allowCoreUpdate: z.boolean().default(true),
	allowServiceRestart: z.boolean().default(true),
	restartGraceSeconds: z.number().min(0).default(8),
	coreGraceSeconds: z.number().min(0).default(10),
	backgroundRefreshSeconds: z.number().min(0).default(0),
	reminderRefreshSeconds: z.number().min(60).default(900),
	batchStopOnError: z.boolean().default(false),
	batchAbortAfterConsecutiveFailures: z.number().min(1).default(3),
	pinned: z.array(z.string()).default([]),
	historyLimit: z.number().min(20).default(400)
});
const LOG_LIMIT = 400;
function json(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text)
	});
	res.end(text);
}
async function readBody(req, limit = 65536) {
	let text = "";
	let size = 0;
	for await (const chunk of req) {
		const piece = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		size += Buffer.byteLength(piece);
		if (size > limit) throw new Error("body-too-large");
		text += piece;
	}
	if (text === "") return {};
	return JSON.parse(text);
}
/** 服务就绪后再跑回调：声明式等 webServer / tools 出现，不依赖启动顺序。 */
function whenReady(ctx, services, run) {
	const injectFn = ctx.inject;
	if (typeof injectFn === "function") {
		const dispose = injectFn.call(ctx, services, (owner) => run(owner));
		return () => {
			try {
				dispose?.();
			} catch {}
		};
	}
	const owner = ctx;
	const dispose = owner.effect(() => {
		if (services.filter((key) => owner.get(key) === void 0).length > 0) return;
		return run(owner);
	}, "dsh-update-center: " + services.join(","));
	return () => {
		try {
			dispose?.();
		} catch {}
	};
}
function apply(ctx, config) {
	const logger = ctx.logger;
	const disposers = [];
	const logs = [];
	let logSeq = 0;
	let cached;
	/** 后台刷新（单飞）：面板打开时旧数据先上屏，这份 Promise 在背后把新数据补上。 */
	let refreshing;
	const pushLog = (entry) => {
		logSeq += 1;
		logs.push({
			seq: logSeq,
			...entry
		});
		if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
	};
	const pluginManager = () => {
		try {
			const service = ctx.get("pluginManager");
			return service === null || service === void 0 ? void 0 : service;
		} catch {
			return;
		}
	};
	const ageOf = (at) => Math.max(0, Math.round((Date.now() - at) / 1e3));
	/**
	* 每条出站快照都过一遍：把「装好了但没重启」的清单贴上去。
	* 服务重启过（ActiveEnterTimestamp 晚于记录时间）就自动销账，不用人工点。
	*/
	const decorate = (snapshot) => {
		let pending = { items: [] };
		try {
			pending = settlePendingRestart(snapshot.env?.service?.since);
		} catch {}
		const items = pending.items ?? [];
		return {
			...snapshot,
			pendingRestart: items,
			summary: {
				...snapshot.summary,
				pendingRestart: items.length
			}
		};
	};
	const runFullScan = async (options = {}) => {
		const snapshot = await scan(pluginManager(), {
			registry: config.registry,
			timeoutMs: config.timeoutMs
		}, options.deep === true ? { deep: true } : {});
		cached = {
			at: Date.now(),
			snapshot
		};
		writeSnapshotCache(snapshot);
		if (snapshot.warnings.length > 0) logger?.warn?.("[update-center] " + snapshot.warnings.join(" | "));
		return snapshot;
	};
	/** 后台刷新：已经有在跑的就不再排第二个（一次完整扫描要十几秒，排队只会更慢）。 */
	const startRefresh = () => {
		if (refreshing !== void 0) return;
		refreshing = runFullScan().catch((error) => {
			logger?.warn?.("[update-center] 后台刷新失败：" + String(error));
		}).finally(() => {
			refreshing = void 0;
		});
	};
	/** 让缓存立刻失效，但**不丢**旧数据：下次读到的还是它（带 refreshing 标记），后台再补新的。 */
	const invalidate = () => {
		if (cached !== void 0) cached = {
			at: 0,
			snapshot: cached.snapshot
		};
	};
	/** 首屏快照：只读本机事实（装了什么 / 什么源 / 什么版本），不碰网络。 */
	const buildFastSnapshot = async () => {
		const snapshot = await scan(pluginManager(), {
			registry: config.registry,
			timeoutMs: config.timeoutMs
		}, { partial: true });
		const ttl = Math.max(0, config.cacheSeconds) * 1e3;
		if (cached === void 0 || Date.now() - cached.at >= ttl) startRefresh();
		return decorate({
			...snapshot,
			refreshing: refreshing !== void 0
		});
	};
	/**
	* 侧栏角标 / 面板状态条用的提醒：**只读缓存与磁盘快照，绝不阻塞**。
	* 快照太旧就在后台排一次刷新（单飞），本次先回上次结果 + `scanning: true`。
	*/
	const buildReminder = () => {
		if (cached === void 0) {
			const disk = readSnapshotCache();
			if (disk !== void 0) cached = disk;
		}
		const window = Math.max(6e4, config.reminderRefreshSeconds * 1e3);
		if (cached === void 0 || Date.now() - cached.at >= window) startRefresh();
		return reminderFrom(cached?.snapshot, {
			scanning: refreshing !== void 0,
			...cached === void 0 ? {} : { ageSeconds: ageOf(cached.at) }
		});
	};
	const buildSnapshot = async (options = {}) => {
		const ttl = Math.max(0, config.cacheSeconds) * 1e3;
		if (cached === void 0) {
			const disk = readSnapshotCache();
			if (disk !== void 0) cached = disk;
		}
		if (options.deep === true) return decorate(await runFullScan({ deep: true }));
		if (options.refresh === true) return decorate(await runFullScan());
		if (cached !== void 0) {
			if (Date.now() - cached.at < ttl) return decorate({
				...cached.snapshot,
				cached: true,
				ageSeconds: ageOf(cached.at)
			});
			startRefresh();
			return decorate({
				...cached.snapshot,
				cached: true,
				refreshing: true,
				ageSeconds: ageOf(cached.at)
			});
		}
		if (options.wait === true) return decorate(await runFullScan());
		return decorate(await buildFastSnapshot());
	};
	const offLog = ctx.on?.("plugin-manager/install-log", (chunk) => {
		if (typeof chunk?.text !== "string") return;
		pushLog({
			at: Date.now(),
			kind: "log",
			stream: typeof chunk.stream === "string" ? chunk.stream : "stdout",
			text: chunk.text
		});
	});
	if (typeof offLog === "function") disposers.push(offLog);
	const offState = ctx.on?.("plugin-manager/update-state", (progress) => {
		if (typeof progress?.step !== "string") return;
		pushLog({
			at: Date.now(),
			kind: "state",
			stream: "state",
			text: "更新阶段：" + progress.step
		});
	});
	if (typeof offState === "function") disposers.push(offState);
	const applyUpdate = async (target, version) => {
		const manager = pluginManager();
		if (manager === void 0 || typeof manager.updateBundle !== "function") return {
			ok: false,
			name: target,
			message: "pluginManager 不可用，无法执行更新"
		};
		let updatable = false;
		let installed;
		try {
			const found = (await manager.listBundles() ?? []).find((bundle) => bundle?.name === target);
			updatable = found?.updatable === true;
			installed = typeof found?.version === "string" ? found.version : void 0;
		} catch (error) {
			return {
				ok: false,
				name: target,
				message: "读取套件清单失败：" + String(error)
			};
		}
		if (!updatable) return {
			ok: false,
			name: target,
			message: "该条目不由 pluginManager 管理（本地链接 / git / 注入），请用对应方式更新"
		};
		if (installed !== void 0 && compareVersions(version, installed) <= 0) return {
			ok: false,
			name: target,
			from: installed,
			to: version,
			message: "目标版本 " + version + " 不高于本地 " + installed + "，跳过（上游已无更新，或版本号取错）"
		};
		pushLog({
			at: Date.now(),
			kind: "state",
			stream: "state",
			text: "开始更新 " + target + " → " + version
		});
		try {
			const result = await manager.updateBundle(target, version, { registry: config.registry });
			const packageResult = result?.result?.packageResult;
			const application = String(result?.result?.application ?? "unknown");
			const message = application === "applied" ? "已安装并热重载生效" : application === "restart-required" ? "已下载安装，但这个包需要重启 DSH 才生效（本插件不会重启）" : "更新未完全成功：" + String(result?.result?.error?.code ?? application);
			const payload = {
				ok: application === "applied" || application === "overridden",
				name: target,
				from: String(result?.from ?? ""),
				to: String(result?.to ?? version),
				application,
				...result?.result?.restartReason === void 0 ? {} : { restartReason: String(result.result.restartReason) },
				message,
				...packageResult === void 0 ? {} : { packageResult: {
					exitCode: Number(packageResult.exitCode ?? -1),
					...packageResult.kind === void 0 ? {} : { kind: String(packageResult.kind) },
					...typeof packageResult.output === "string" ? { output: packageResult.output.slice(-4e3) } : {},
					...typeof packageResult.logPath === "string" ? { logPath: packageResult.logPath } : {}
				} }
			};
			invalidate();
			if (application === "restart-required") addPendingRestart([{
				name: target,
				at: (/* @__PURE__ */ new Date()).toISOString(),
				...payload.from === void 0 || payload.from === "" ? {} : { from: payload.from },
				to: payload.to,
				...payload.restartReason === void 0 ? {} : { reason: payload.restartReason }
			}]);
			pushLog({
				at: Date.now(),
				kind: "state",
				stream: "state",
				text: "更新结束 " + target + "：" + message
			});
			appendHistory({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				kind: "single",
				name: target,
				from: payload.from,
				to: payload.to,
				ok: payload.ok,
				application,
				message
			}, config.historyLimit);
			return payload;
		} catch (error) {
			invalidate();
			pushLog({
				at: Date.now(),
				kind: "state",
				stream: "state",
				text: "更新失败 " + target + "：" + String(error)
			});
			appendHistory({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				kind: "single",
				name: target,
				to: version,
				ok: false,
				message: "更新异常：" + String(error)
			}, config.historyLimit);
			return {
				ok: false,
				name: target,
				message: "更新异常：" + String(error)
			};
		}
	};
	const batch = new BatchRunner({
		apply: applyUpdate,
		invalidate: () => {
			invalidate();
		},
		stopOnError: config.batchStopOnError,
		abortAfterConsecutiveFailures: config.batchAbortAfterConsecutiveFailures,
		onItemDone: (item) => {
			appendHistory({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				kind: "batch",
				name: item.name,
				from: item.from,
				to: item.to,
				ok: item.status === "ok",
				application: item.application,
				message: item.message
			}, config.historyLimit);
		}
	});
	/**
	* 从快照推出批量计划。
	* stable 通道只动「有更新的正式版」的包；preview 通道才碰预览版（含仅预览版更新的包）。
	*/
	const buildPlan = (snapshot, channel, only) => {
		const plan = [];
		const skipped = [];
		const wanted = only === void 0 ? void 0 : new Set(only);
		for (const row of snapshot.bundles) {
			if (wanted !== void 0 && !wanted.has(row.name)) continue;
			if (row.updatable !== true) continue;
			if (config.pinned.includes(row.name)) {
				skipped.push({
					name: row.name,
					reason: "在 pinned 名单里，跳过"
				});
				continue;
			}
			if (row.status === "update") {
				const target = channel === "preview" ? row.preview ?? row.stable : row.stable;
				if (target === void 0) {
					skipped.push({
						name: row.name,
						reason: "没有可用的目标版本"
					});
					continue;
				}
				plan.push({
					name: row.name,
					...row.installed === void 0 ? {} : { from: row.installed },
					to: target.version,
					channel: channel === "preview" && row.preview !== void 0 ? "preview" : "stable"
				});
				continue;
			}
			if (row.status === "preview-only" && channel === "preview" && row.preview !== void 0) plan.push({
				name: row.name,
				...row.installed === void 0 ? {} : { from: row.installed },
				to: row.preview.version,
				channel: "preview"
			});
		}
		return {
			plan,
			skipped
		};
	};
	disposers.push(whenReady(ctx, ["webServer"], (owner) => {
		const webServer = owner.webServer;
		const routes = [
			{
				kind: "exact",
				path: "/api/dsh-update-center/snapshot",
				handler: async (req, res) => {
					if (req.method !== "GET") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					try {
						const url = new URL(req.url ?? "/", "http://127.0.0.1");
						json(res, 200, url.searchParams.get("mode") === "local" ? await buildFastSnapshot() : await buildSnapshot({
							refresh: url.searchParams.get("refresh") === "1",
							deep: url.searchParams.get("deep") === "1"
						}));
					} catch (error) {
						json(res, 500, {
							ok: false,
							error: String(error)
						});
					}
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/badge",
				handler: (req, res) => {
					if (req.method !== "GET") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					try {
						json(res, 200, buildReminder());
					} catch (error) {
						json(res, 500, {
							ok: false,
							error: String(error)
						});
					}
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/update",
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					let body;
					try {
						body = await readBody(req);
					} catch (error) {
						return json(res, 400, {
							ok: false,
							error: String(error)
						});
					}
					const target = typeof body?.name === "string" ? body.name : "";
					const version = typeof body?.version === "string" ? body.version : "";
					if (target === "" || version === "") return json(res, 400, {
						ok: false,
						error: "name 与 version 必填"
					});
					const result = await applyUpdate(target, version);
					json(res, result.ok ? 200 : 409, result);
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/convert",
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					let body;
					try {
						body = await readBody(req);
					} catch (error) {
						return json(res, 400, {
							ok: false,
							error: String(error)
						});
					}
					const name = typeof body?.name === "string" ? body.name.trim() : "";
					if (name === "") return json(res, 400, {
						ok: false,
						error: "name 必填"
					});
					const version = typeof body?.version === "string" ? body.version.trim() : "";
					if (version !== "" && !isSafeVersion(version)) return json(res, 400, {
						ok: false,
						error: "version 必须是合法 semver"
					});
					pushLog({
						at: Date.now(),
						kind: "state",
						stream: "state",
						text: "开始转线上 " + name
					});
					const result = await convertToRegistry(pluginManager(), {
						name,
						...version === "" ? {} : { version },
						registry: config.registry,
						timeoutMs: config.timeoutMs,
						injected: body?.injected === true,
						confirmOverwrite: body?.confirmOverwrite === true
					});
					invalidate();
					if (result.ok && result.application === "restart-required") addPendingRestart([{
						name,
						at: (/* @__PURE__ */ new Date()).toISOString(),
						...result.from === void 0 ? {} : { from: result.from },
						to: String(result.to ?? version),
						...result.restartReason === void 0 ? {} : { reason: result.restartReason }
					}]);
					pushLog({
						at: Date.now(),
						kind: "state",
						stream: "state",
						text: "转线上结束 " + name + "：" + String(result.message ?? "")
					});
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "convert",
						name,
						...result.from === void 0 ? {} : { from: result.from },
						...result.to === void 0 ? {} : { to: result.to },
						ok: result.ok,
						...result.application === void 0 ? {} : { application: result.application },
						...result.message === void 0 ? {} : { message: result.message }
					}, config.historyLimit);
					json(res, result.ok ? 200 : 409, result);
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/pending-restart",
				handler: async (req, res) => {
					if (req.method === "GET") return json(res, 200, {
						ok: true,
						...readPendingRestart()
					});
					if (req.method !== "POST" && req.method !== "DELETE") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					json(res, 200, {
						ok: true,
						...clearPendingRestart("user")
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/restart-service",
				handler: async (req, res) => {
					if (req.method === "GET") {
						const runs = listRestartRuns();
						const latest = runs[0] ?? null;
						const runId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("runId") ?? latest?.runId ?? "";
						const log = runId === "" ? "" : readRestartLog(runId);
						return json(res, 200, {
							ok: true,
							allowServiceRestart: config.allowServiceRestart,
							serviceName: config.serviceName,
							latest,
							runs: runs.slice(0, 5),
							...runId === "" ? {} : {
								runId,
								log
							}
						});
					}
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					if (!config.allowServiceRestart) return json(res, 403, {
						ok: false,
						error: "配置里关掉了一键重启（allowServiceRestart=false）"
					});
					const graceRaw = Number(new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("grace") ?? "");
					const graceSeconds = Number.isFinite(graceRaw) && graceRaw >= 0 ? Math.min(120, Math.floor(graceRaw)) : config.restartGraceSeconds;
					const launched = await launchServiceRestart({
						serviceName: config.serviceName,
						healthUrl: config.healthUrl,
						graceSeconds
					});
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "restart",
						name: config.serviceName,
						ok: launched.ok,
						message: launched.message
					}, config.historyLimit);
					json(res, launched.ok ? 200 : 500, {
						...launched,
						latest: launched.runId === void 0 ? null : readRestartRun(launched.runId) ?? null
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/update-all",
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					if (batch.running()) return json(res, 409, {
						ok: false,
						error: "已有批量更新在执行",
						batch: batch.current()
					});
					let body;
					try {
						body = await readBody(req);
					} catch (error) {
						return json(res, 400, {
							ok: false,
							error: String(error)
						});
					}
					const channel = body?.channel === "preview" ? "preview" : "stable";
					const only = Array.isArray(body?.names) && body.names.every((name) => typeof name === "string") ? body.names : void 0;
					try {
						const snapshot = await buildSnapshot({ refresh: true });
						const { plan, skipped } = buildPlan(snapshot, channel, only);
						if (plan.length === 0) return json(res, 200, {
							ok: true,
							started: false,
							message: channel === "stable" ? "没有需要更新的正式版" : "没有需要更新的版本",
							skipped,
							batch: null
						});
						json(res, 200, {
							ok: true,
							started: true,
							batch: batch.start(plan, channel),
							skipped
						});
					} catch (error) {
						json(res, 500, {
							ok: false,
							error: String(error)
						});
					}
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/batch",
				handler: (req, res) => {
					if (req.method !== "GET") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					json(res, 200, { batch: batch.current() ?? null });
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/batch/cancel",
				handler: (req, res) => {
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					json(res, 200, {
						ok: true,
						cancelled: batch.cancel(),
						batch: batch.current() ?? null
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/core-update",
				handler: async (req, res) => {
					new URL(req.url ?? "/", "http://127.0.0.1");
					if (req.method === "GET") {
						const runs = listCoreRuns();
						const latest = runs[0];
						return json(res, 200, {
							ok: true,
							allowCoreUpdate: config.allowCoreUpdate,
							serviceName: config.serviceName,
							healthUrl: config.healthUrl,
							inFlight: coreUpdateInFlight(latest),
							latest: latest ?? null,
							runs: runs.slice(0, 10)
						});
					}
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					if (!config.allowCoreUpdate) return json(res, 403, {
						ok: false,
						error: "配置里关掉了本体更新（allowCoreUpdate=false）"
					});
					let body;
					try {
						body = await readBody(req);
					} catch (error) {
						return json(res, 400, {
							ok: false,
							error: String(error)
						});
					}
					const version = typeof body?.version === "string" ? body.version.trim() : "";
					if (version === "" || !isSafeVersion(version)) return json(res, 400, {
						ok: false,
						error: "version 必填且必须是合法 semver"
					});
					if (coreUpdateInFlight(listCoreRuns()[0])) return json(res, 409, {
						ok: false,
						error: "已有本体更新在执行",
						latest: listCoreRuns()[0] ?? null
					});
					let snapshot;
					try {
						snapshot = await buildSnapshot({ refresh: true });
					} catch (error) {
						return json(res, 500, {
							ok: false,
							error: "扫描失败：" + String(error)
						});
					}
					const core = snapshot.core;
					const allowed = [core.channels.stable?.version, core.channels.preview?.version].filter((value) => value !== void 0);
					if (!allowed.includes(version)) return json(res, 400, {
						ok: false,
						error: "只接受扫描结果里的正式版或预览版版本号（" + (allowed.join(" / ") || "上游不可查") + "）"
					});
					if (core.runtimeDir === void 0 || core.version === void 0) return json(res, 400, {
						ok: false,
						error: "定位不到本体运行时目录，无法一键更新"
					});
					const dryRun = body?.dryRun === true;
					const graceSeconds = typeof body?.graceSeconds === "number" && Number.isFinite(body.graceSeconds) ? Math.min(120, Math.max(0, Math.floor(body.graceSeconds))) : config.coreGraceSeconds;
					if (!dryRun && compareVersions(version, core.version) <= 0) return json(res, 400, {
						ok: false,
						error: "目标版本 " + version + " 不高于当前 " + core.version + "，拒绝降级"
					});
					const launched = await launchCoreUpdate({
						runtimeDir: core.runtimeDir,
						from: core.version,
						target: version,
						registry: config.registry,
						serviceName: config.serviceName,
						healthUrl: config.healthUrl,
						dryRun,
						graceSeconds
					});
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "core",
						name: core.name,
						from: core.version,
						to: version,
						ok: launched.ok,
						message: launched.message
					}, config.historyLimit);
					json(res, launched.ok ? 200 : 500, {
						...launched,
						latest: launched.runId === void 0 ? null : readCoreRun(launched.runId) ?? null
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/core-update/log",
				handler: (req, res) => {
					if (req.method !== "GET") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					const runId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("runId") ?? listCoreRuns()[0]?.runId ?? "";
					if (runId === "") return json(res, 404, {
						ok: false,
						error: "没有可读的 run"
					});
					json(res, 200, {
						ok: true,
						runId,
						log: readCoreLog(runId)
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/history",
				handler: (req, res) => {
					if (req.method !== "GET") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					const limitRaw = Number(url.searchParams.get("limit") ?? "30");
					json(res, 200, {
						ok: true,
						entries: readHistory(Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 30)
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/log",
				handler: (req, res) => {
					if (req.method !== "GET") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					const since = Number(url.searchParams.get("since") ?? "0");
					json(res, 200, {
						entries: logs.filter((entry) => entry.seq > (Number.isFinite(since) ? since : 0)),
						lastSeq: logSeq
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/infra",
				handler: async (req, res) => {
					if (req.method !== "GET") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					const refresh = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("refresh") === "1";
					try {
						json(res, 200, {
							ok: true,
							infra: await scanInfra({ refresh })
						});
					} catch (err) {
						json(res, 500, {
							ok: false,
							message: String(err?.message ?? err)
						});
					}
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/infra/docker-update",
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					const body = await readBody(req);
					const node = String(body?.node ?? "local").trim();
					const name = String(body?.name ?? "").trim();
					if (!node || !name) return json(res, 400, {
						ok: false,
						message: "需要合法的 node 与容器 name"
					});
					pushLog({
						at: Date.now(),
						kind: "state",
						text: `[infra] 开始更新容器 ${node}:${name}`
					});
					const result = await updateDockerContainer(node, name);
					pushLog({
						at: Date.now(),
						kind: result.ok ? "state" : "log",
						text: `[infra] ${result.message}`
					});
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "docker",
						name: `${node}:${name}`,
						ok: result.ok,
						message: result.message
					}, config.historyLimit);
					const infra = await scanInfra({ refresh: true });
					json(res, result.ok ? 200 : 500, {
						...result,
						infra
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/infra/apt-update",
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					const body = await readBody(req);
					const node = String(body?.node ?? "local").trim();
					if (!node) return json(res, 400, {
						ok: false,
						message: "需要合法的 node 标识"
					});
					pushLog({
						at: Date.now(),
						kind: "state",
						text: `[infra] 开始更新 ${node.toUpperCase()} 安全 APT 包`
					});
					const result = await updateSafeApt(node);
					pushLog({
						at: Date.now(),
						kind: result.ok ? "state" : "log",
						text: `[infra] ${result.message}`
					});
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "apt",
						name: `${node}:safe-apt`,
						ok: result.ok,
						message: result.message
					}, config.historyLimit);
					const infra = await scanInfra({ refresh: true });
					json(res, result.ok ? 200 : 500, {
						...result,
						infra
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/infra/toolchain-update",
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					const body = await readBody(req);
					const id = String(body?.id ?? "").trim();
					if (!id) return json(res, 400, {
						ok: false,
						message: "需要工具链条目 id (如 uv / pnpm / litellm / obsidian / npm:catbus-cli)"
					});
					pushLog({
						at: Date.now(),
						kind: "state",
						text: `[infra] 开始更新本机工具 ${id}`
					});
					const result = await updateToolchainItem(id);
					pushLog({
						at: Date.now(),
						kind: result.ok ? "state" : "log",
						text: `[infra] ${result.message}`
					});
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "toolchain",
						name: `toolchain:${id}`,
						ok: result.ok,
						message: result.message
					}, config.historyLimit);
					const infra = await scanInfra({ refresh: true });
					json(res, result.ok ? 200 : 500, {
						...result,
						infra
					});
				}
			},
			{
				kind: "exact",
				path: "/api/dsh-update-center/infra/venv-update",
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					const body = await readBody(req);
					const projectId = String(body?.projectId ?? "").trim();
					if (!projectId) return json(res, 400, {
						ok: false,
						message: "需要项目虚拟环境 projectId（来自 infra-scan 自动发现的项目 id）"
					});
					pushLog({
						at: Date.now(),
						kind: "state",
						text: `[infra] 开始升级项目虚拟环境 ${projectId} 同主版本安全包`
					});
					const result = await updateProjectVenv(projectId);
					pushLog({
						at: Date.now(),
						kind: result.ok ? "state" : "log",
						text: `[infra] ${result.message}`
					});
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "venv",
						name: `venv:${projectId}`,
						ok: result.ok,
						message: result.message
					}, config.historyLimit);
					const infra = await scanInfra({ refresh: true });
					json(res, result.ok ? 200 : 500, {
						...result,
						infra
					});
				}
			}
		];
		const registered = routes.map((route) => webServer.register(route));
		logger?.info?.("[update-center] 已注册 " + routes.length + " 条路由于 /api/dsh-update-center");
		return () => {
			for (const dispose of registered) try {
				dispose?.();
			} catch {}
		};
	}));
	disposers.push(whenReady(ctx, ["tools"], (owner) => {
		const definition = defineTool({
			name: "dsh_update_center",
			description: "扫描并更新本机与跨节点运维组件：DSH 本体、已装插件与套件（npm / 本地链接 / git / 压缩包 / 注入）、三节点 Docker 容器（VM100 / iStoreOS / fnOS）、双节点 APT 系统安全包（VM100 / PVE）、本机核心工具链（uv / pnpm / litellm / 全局 CLI / Obsidian）与项目 Python 虚拟环境（.venv）。action=scan 返回 DSH 总览；action=infra-scan 返回跨节点 Docker、APT、工具链与项目 .venv 审计快照；action=docker-update 更新指定节点的非锁定容器；action=apt-update 更新指定节点的安全非内核 APT 包；action=toolchain-update 更新本机指定 CLI/桌面工具；action=venv-update 更新指定项目 .venv 的同主版本安全包；action=update 升级单个套件（热更新，不重启）；action=convert 把本地链接/git/压缩包/注入的条目换成上游 registry 依赖；action=update-all 串行更新所有可更新套件；action=batch 查批量进度；action=core-update 一键更新 DSH 本体；action=history 查更新历史。",
			parameters: {
				action: {
					type: "string",
					enum: [
						"scan",
						"infra-scan",
						"docker-update",
						"apt-update",
						"toolchain-update",
						"venv-update",
						"update",
						"convert",
						"update-all",
						"batch",
						"core-update",
						"history"
					],
					required: true,
					description: "scan=DSH总览；infra-scan=跨节点Docker/APT/工具链/venv审计；docker-update=更新容器；apt-update=更新安全APT包；toolchain-update=更新本机工具；venv-update=更新项目Python虚拟环境；update=升级单个套件；convert=本地源转线上；update-all=批量升级；batch=批量进度；core-update=更新 DSH 本体；history=更新历史"
				},
				node: {
					type: "string",
					description: "docker-update / apt-update 时的目标节点 id（默认本机 local，或已发现的 vm100 / istoreos / fnos / pve 等）"
				},
				name: {
					type: "string",
					description: "update / convert 时的套件包名，docker-update 时的容器名，toolchain-update 时的工具 id（如 uv/pnpm/litellm/obsidian/npm:<pkg>/uv-tool:<tool>），或 venv-update 时的项目 id"
				},
				version: {
					type: "string",
					description: "update / core-update / convert 时的目标版本（取 scan 结果里的 stable/preview 版本号；convert 省略则用上游最新版）"
				},
				injected: {
					type: "boolean",
					description: "convert 时说明这是运行时注入条目（超级注入器），装成线上依赖后还需 dev_uninject_plugin 解除注入"
				},
				confirmOverwrite: {
					type: "boolean",
					description: "convert 时确认覆盖本地改动：本地目录与上游同版本不一致时，不带这个参数一律拒绝（先看 scan 报出的「本地改动」）"
				},
				channel: {
					type: "string",
					enum: ["stable", "preview"],
					description: "update-all 时的通道，默认 stable（只更正式版）"
				},
				dryRun: {
					type: "boolean",
					description: "core-update 时只跑预检（不停服、不安装），用于验证链路是否通"
				},
				refresh: {
					type: "boolean",
					description: "scan 时忽略缓存重新扫描"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { report: {
						type: "string",
						required: true
					} }
				},
				render: (_args, value) => [{
					type: "text",
					text: value.report
				}]
			},
			async execute(args) {
				const action = String(args?.action ?? "scan");
				if (action === "infra-scan") {
					const infra = await scanInfra({ refresh: args?.refresh === true });
					const lines = [`跨节点 Docker 容器（可更新 ${infra.docker.updatableCount} 个 / 锁定保护 ${infra.docker.lockedCount} 个）：`];
					for (const c of infra.docker.containers) {
						const tag = c.status === "update" ? "🟡可更新" : c.status === "locked" ? "🔒已锁定" : c.status === "latest" ? "🟢最新" : "⚠️异常";
						lines.push(`- [${c.nodeLabel}] ${c.name} (${c.image}) → ${tag} ｜ ${c.detail ?? ""}`);
					}
					lines.push(`\n跨节点 APT 软件包（安全可更 ${infra.apt.safeUpdatableCount} 个 / 门禁锁定 ${infra.apt.lockedCount} 个）：`);
					const aptRows = infra.apt.nodes ? infra.apt.nodes.flatMap((n) => n.packages) : [...infra.apt.vm100, ...infra.apt.pve];
					for (const p of aptRows) {
						const tag = p.locked ? "🔒门禁锁定" : "🟡安全可更";
						lines.push(`- [${(p.nodeLabel ?? p.node).toUpperCase()}] ${p.name}: ${p.installed} → ${p.candidate} (${tag}${p.lockReason ? "：" + p.lockReason : ""})`);
					}
					if (infra.toolchain) {
						lines.push(`\n本机核心工具链与全局 CLI（可更新 ${infra.toolchain.updatableCount} 个 / 共 ${infra.toolchain.items.length} 个）：`);
						for (const t of infra.toolchain.items) {
							const tag = t.status === "update" ? "🟡可更新" : "🟢最新";
							lines.push(`- [${t.id}] ${t.name}: ${t.installed} → ${t.latest ?? "—"} (${tag}) ｜ ${t.detail ?? ""}`);
						}
					}
					if (infra.venvs) {
						lines.push(`\n项目 Python 虚拟环境 .venv（安全可更 ${infra.venvs.totalSafeUpdatable} 个包）：`);
						for (const v of infra.venvs.projects) {
							lines.push(`- [${v.id}] ${v.project} (Python ${v.pythonVersion}): 待升级 ${v.outdatedCount} 个（同主版本安全可更 ${v.safeUpdatableCount} 个）`);
							for (const p of v.packages) lines.push(`    · ${p.name}: ${p.installed} → ${p.latest} (${p.safe ? "🟡安全可更" : "🔒锁定：" + (p.lockReason ?? "跨大版本")})`);
						}
					}
					return { report: lines.join("\n") };
				}
				if (action === "toolchain-update") {
					const id = String(args?.name ?? "").trim();
					if (!id) return { report: "toolchain-update 需要 name 参数指定工具链 id（如 uv / pnpm / litellm / obsidian / npm:catbus-cli）" };
					const res = await updateToolchainItem(id);
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "toolchain",
						name: `toolchain:${id}`,
						ok: res.ok,
						message: res.message
					}, config.historyLimit);
					return { report: `${res.ok ? "OK" : "FAIL"} | ${res.message}${res.output ? "\n" + res.output : ""}` };
				}
				if (action === "venv-update") {
					const projectId = String(args?.name ?? "").trim();
					if (!projectId) return { report: "venv-update 需要 name 参数指定项目 id（来自 infra-scan 自动发现的虚拟环境 id）" };
					const res = await updateProjectVenv(projectId);
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "venv",
						name: `venv:${projectId}`,
						ok: res.ok,
						message: res.message
					}, config.historyLimit);
					return { report: `${res.ok ? "OK" : "FAIL"} | ${res.message}${res.output ? "\n" + res.output : ""}` };
				}
				if (action === "docker-update") {
					const node = String(args?.node ?? "local").trim();
					const name = String(args?.name ?? "").trim();
					if (!node || !name) return { report: "docker-update 需要合法的 node 与容器 name" };
					const res = await updateDockerContainer(node, name);
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "docker",
						name: `${node}:${name}`,
						ok: res.ok,
						message: res.message
					}, config.historyLimit);
					return { report: `${res.ok ? "OK" : "FAIL"} | ${res.message}${res.output ? "\n" + res.output : ""}` };
				}
				if (action === "apt-update") {
					const node = String(args?.node ?? "local").trim();
					if (!node) return { report: "apt-update 需要合法的 node 标识" };
					const res = await updateSafeApt(node);
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "apt",
						name: `${node}:safe-apt`,
						ok: res.ok,
						message: res.message
					}, config.historyLimit);
					return { report: `${res.ok ? "OK" : "FAIL"} | ${res.message}${res.output ? "\n" + res.output : ""}` };
				}
				if (action === "update") {
					const target = String(args?.name ?? "");
					const version = String(args?.version ?? "");
					if (target === "" || version === "") return { report: "update 需要 name 与 version" };
					const result = await applyUpdate(target, version);
					return { report: [
						target,
						result.message ?? "",
						result.application ?? ""
					].filter((part) => part !== "").join(" | ") };
				}
				if (action === "convert") {
					const target = String(args?.name ?? "").trim();
					if (target === "") return { report: "convert 需要 name" };
					const version = String(args?.version ?? "").trim();
					const result = await convertToRegistry(pluginManager(), {
						name: target,
						...version === "" ? {} : { version },
						registry: config.registry,
						timeoutMs: config.timeoutMs,
						injected: args?.injected === true,
						confirmOverwrite: args?.confirmOverwrite === true
					});
					invalidate();
					if (result.ok && result.application === "restart-required") addPendingRestart([{
						name: target,
						at: (/* @__PURE__ */ new Date()).toISOString(),
						...result.from === void 0 ? {} : { from: result.from },
						to: String(result.to ?? version),
						...result.restartReason === void 0 ? {} : { reason: result.restartReason }
					}]);
					return { report: [
						target,
						result.ok ? "OK" : "FAIL",
						result.message ?? ""
					].filter((part) => part !== "").join(" | ") };
				}
				if (action === "update-all") {
					if (batch.running()) return { report: "已有批量更新在执行，先用 action=batch 看进度" };
					const channel = args?.channel === "preview" ? "preview" : "stable";
					const snapshot = await buildSnapshot({ refresh: true });
					const { plan, skipped } = buildPlan(snapshot, channel);
					if (plan.length === 0) return { report: "没有需要更新的条目（通道 " + channel + "）" };
					const lines = ["已开始批量更新 " + batch.start(plan, channel).total + " 个套件（通道 " + channel + "，串行）：", ...plan.map((item) => "- " + item.name + " → " + item.to)];
					if (skipped.length > 0) lines.push("跳过 " + skipped.length + " 个：" + skipped.map((entry) => entry.name + "（" + entry.reason + "）").join("；"));
					lines.push("进度用 action=batch 查。");
					return { report: lines.join("\n") };
				}
				if (action === "batch") {
					const state = batch.current();
					if (state === void 0) return { report: "还没有批量更新记录" };
					const lines = ["批量更新 " + (state.running ? "进行中" : "已结束") + "：" + state.done + "/" + state.total + "，成功 " + state.summary.ok + "，需重启 " + state.summary.warn + "，失败 " + state.summary.failed + "，跳过 " + state.summary.skipped + (state.cancelled ? "（已叫停）" : "")];
					for (const item of state.items) lines.push("- [" + (item.status === "warn" ? "需重启" : item.status) + "] " + item.name + " → " + item.to + (item.message === void 0 ? "" : "：" + item.message));
					return { report: lines.join("\n") };
				}
				if (action === "core-update") {
					if (!config.allowCoreUpdate) return { report: "配置里关掉了本体更新（allowCoreUpdate=false）" };
					const version = String(args?.version ?? "");
					if (version === "" || !isSafeVersion(version)) return { report: "core-update 需要合法的 version（取 scan 结果里的 stable/preview 版本号）" };
					if (coreUpdateInFlight(listCoreRuns()[0])) return { report: "已有本体更新在执行，先看 GET /api/dsh-update-center/core-update" };
					const core = (await buildSnapshot({ refresh: true })).core;
					const allowed = [core.channels.stable?.version, core.channels.preview?.version].filter((value) => value !== void 0);
					if (!allowed.includes(version)) return { report: "只接受扫描结果里的版本号：" + (allowed.join(" / ") || "上游不可查") };
					if (core.runtimeDir === void 0 || core.version === void 0) return { report: "定位不到本体运行时目录" };
					const dryRun = args?.dryRun === true;
					if (!dryRun && compareVersions(version, core.version) <= 0) return { report: "目标版本 " + version + " 不高于当前 " + core.version + "，拒绝降级" };
					const launched = await launchCoreUpdate({
						runtimeDir: core.runtimeDir,
						from: core.version,
						target: version,
						registry: config.registry,
						serviceName: config.serviceName,
						healthUrl: config.healthUrl,
						dryRun,
						graceSeconds: config.coreGraceSeconds
					});
					appendHistory({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "core",
						name: core.name,
						from: core.version,
						to: version,
						ok: launched.ok,
						message: launched.message
					}, config.historyLimit);
					return { report: launched.message + (launched.logPath === void 0 ? "" : "\n日志：" + launched.logPath) + "\n注意：服务会重启，当前会话会中断，恢复后到更新中心面板看结果。" };
				}
				if (action === "history") {
					const entries = readHistory(30);
					if (entries.length === 0) return { report: "没有更新历史" };
					return { report: entries.map((entry) => entry.at.replace("T", " ").slice(0, 19) + " | " + entry.kind + " | " + (entry.name ?? "") + " " + (entry.from ?? "") + "→" + (entry.to ?? "") + " | " + (entry.ok ? "OK" : "FAIL") + (entry.message === void 0 ? "" : " | " + entry.message)).join("\n") };
				}
				const snapshot = await buildSnapshot({
					refresh: args?.refresh === true,
					wait: true
				});
				const core = snapshot.core;
				const lines = ["DSH 本体：本地 " + (core.version ?? "未知") + " ｜ 正式版 " + (core.channels.stable?.version ?? "—") + " ｜ 预览版 " + (core.channels.preview?.version ?? "—") + "（" + core.status + "）"];
				const rows = snapshot.bundles.filter((row) => row.status === "update" || row.status === "preview-only");
				lines.push("可更新套件 " + rows.length + " 个（已查 " + snapshot.summary.scannedBundles + " 个 registry 包）：");
				for (const row of rows) lines.push("- " + row.name + "  本地 " + (row.installed ?? "?") + " → 正式版 " + (row.stable?.version ?? "—") + " / 预览版 " + (row.preview?.version ?? "—") + "（" + row.status + "）");
				lines.push("注入插件 " + snapshot.injected.length + " 个 ｜ node " + snapshot.env.node + " ｜ pnpm " + (snapshot.env.pnpm ?? "未装") + " ｜ dsh.service " + (snapshot.env.service.active ?? "未知"));
				const convertible = [...snapshot.bundles, ...snapshot.injected].filter((row) => row.upstream?.convertible === true && row.upstream.version !== void 0);
				if (convertible.length > 0) {
					lines.push("可转线上（本地源 → registry 依赖）" + convertible.length + " 个：");
					for (const row of convertible) lines.push("- " + row.name + "  本地 " + (row.installed ?? "?") + " → 上游 " + String(row.upstream?.version ?? "") + "（" + row.sourceKind + "）" + (row.kind === "injected" ? "｜注入条目，装完需 dev_uninject_plugin 解除注入" : "") + (row.localDelta === void 0 ? "" : "｜" + (row.localDelta.status === "identical" ? "与上游一致（无损）" : row.localDelta.status === "modified" ? "本地与上游不同（内容不同 " + String(row.localDelta.modifiedCount ?? 0) + " / 仅本地有 " + String(row.localDelta.localOnlyCount ?? 0) + " / 仅上游有 " + String(row.localDelta.upstreamOnlyCount ?? 0) + "）：" + (row.localDelta.changedFiles ?? []).slice(0, 5).join("、") + "（转线上后生效的是上游版本；确认覆盖需 confirmOverwrite=true）" : "无法比对：" + String(row.localDelta.reason ?? ""))));
				}
				const pending = snapshot.pendingRestart ?? [];
				if (pending.length > 0) {
					lines.push("需重启 DSH 才生效 " + pending.length + " 个（面板可一键重启，或 sudo systemctl restart " + snapshot.env.service.name + "）：");
					for (const item of pending) lines.push("- " + item.name + " " + (item.from ?? "?") + " → " + (item.to ?? "?") + "（" + item.at + "）");
				}
				return { report: lines.join("\n") };
			}
		});
		const dispose = owner.tools.register(definition);
		return () => {
			try {
				dispose?.();
			} catch {}
		};
	}));
	ctx.effect(() => () => {
		for (const dispose of disposers.splice(0)) dispose();
	}, "dsh-update-center: teardown");
	logger?.info?.("[update-center] 启动，registry=" + config.registry);
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map