/** 更新历史：JSONL 追加，只保留最近 N 条。面板和 agent 都能读。 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryEntry } from '../shared/types.js'
import { updateCenterHome } from './core.js'

const KEEP = 400

function historyPath(): string {
  return join(updateCenterHome(), 'history.jsonl')
}

export function appendHistory(entry: HistoryEntry, limit = KEEP): void {
  try {
    mkdirSync(updateCenterHome(), { recursive: true })
    appendFileSync(historyPath(), JSON.stringify(entry) + '\n', 'utf8')
    trim(limit)
  } catch {
    /* 历史是辅助信息，写失败不影响更新本身 */
  }
}

function trim(limit: number): void {
  try {
    const lines = readFileSync(historyPath(), 'utf8').split('\n').filter((line) => line.trim() !== '')
    if (lines.length <= limit + 50) return
    writeFileSync(historyPath(), lines.slice(-limit).join('\n') + '\n', 'utf8')
  } catch {
    /* 忽略 */
  }
}

export function readHistory(limit = 30): HistoryEntry[] {
  const path = historyPath()
  if (!existsSync(path)) return []
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const entries: HistoryEntry[] = []
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line) as HistoryEntry
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.at === 'string') entries.push(parsed)
      } catch {
        /* 跳过坏行 */
      }
    }
    return entries.reverse()
  } catch {
    return []
  }
}
