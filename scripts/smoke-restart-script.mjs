/**
 * 一键重启脚本的语法冒烟测试：生成脚本 → `bash -n` 语法检查。
 * 不执行、不重启服务（真重启会掐断当前会话）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRestartScript } from '../lib/types/host/core.js'

const dir = mkdtempSync(join(tmpdir(), 'uc-restart-'))
const script = buildRestartScript({ serviceName: 'dsh.service', healthUrl: 'http://127.0.0.1:3080/', graceSeconds: 8 }, dir)
const path = join(dir, 'restart.sh')
writeFileSync(path, script)
try {
  execFileSync('bash', ['-n', path], { stdio: 'pipe' })
  console.log('PASS bash -n（' + script.split('\n').length + ' 行）')
} catch (error) {
  console.error('FAIL bash -n: ' + String(error.stderr ?? error))
  process.exit(1)
}
const must = ['systemctl restart "$SERVICE"', 'res restarting', 'res done true', 'res failed false', 'health_ok']
for (const token of must) {
  const ok = script.includes(token)
  console.log((ok ? 'PASS ' : 'FAIL ') + token)
  if (!ok) process.exit(1)
}
console.log('script bytes:', readFileSync(path).length)
