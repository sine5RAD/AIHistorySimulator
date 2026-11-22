import type { ScenarioData } from '@/types/scenario'
import { isRecord } from './country-data'
import { normalizeScenarioData, serializeScenarioForExport } from './scenario-data'

/** 剧本编辑页 -> 事件驱动页的一次性交接存储键。 */
export const SCENARIO_TRANSFER_KEY = 'event-drive-scenario-json'

/** 让事件驱动页忽略旧聊天草稿与快照的标记，与世界观页发送时保持一致。 */
export const EVENT_DRIVE_FRESH_SESSION_KEY = 'event-drive-fresh-session'

export interface ScenarioTransferPayload {
  source: 'scenario-editor'
  sentAt: string
  scenario: ScenarioData
}

/**
 * 把当前剧本序列化成导出结构再交接，避免把 Vue 响应式对象直接写进存储。
 * `sentAt` 同时用于事件驱动页的存档键与快照标签。
 */
export const createScenarioTransferPayload = (
  scenario: ScenarioData,
  sentAt = new Date().toISOString(),
): ScenarioTransferPayload => ({
  source: 'scenario-editor',
  sentAt,
  scenario: serializeScenarioForExport(normalizeScenarioData(scenario)),
})

/**
 * 解析交接内容。兼容两种写法：
 * - `{ source, sentAt, scenario }`：剧本编辑页发送的完整交接包；
 * - 直接粘贴的 `剧本.json`。
 *
 * 没有政权时返回 null，避免事件驱动页加载一个空世界。
 */
export const parseScenarioTransferPayload = (value: unknown): ScenarioTransferPayload | null => {
  if (!isRecord(value)) {
    return null
  }

  const scenario = normalizeScenarioData(value.scenario ?? value)

  if (!scenario.存在国家.length) {
    return null
  }

  return {
    source: 'scenario-editor',
    sentAt:
      typeof value.sentAt === 'string' && value.sentAt.trim()
        ? value.sentAt
        : new Date().toISOString(),
    scenario,
  }
}
