import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleScript } from './sample'
import type {
  Character,
  ContinuityState,
  DiffItem,
  Prop,
  Reply,
  Scene,
  Script,
  UnitGroup,
  Version,
  Wardrobe,
  WarningItem,
  WarningReview,
  WarningStatus,
  WarningType
} from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export const unitOptions: Array<{ value: UnitGroup; label: string }> = [
  { value: 'ext', label: '外景组' },
  { value: 'int', label: '内景组' },
  { value: 'mixed', label: '混合组' }
]
export const unitLabel = (unit: string) => unitOptions.find((option) => option.value === unit)?.label ?? unit

const unitFromIntExt = (intExt: Scene['intExt']): UnitGroup => (intExt === 'INT' ? 'int' : intExt === 'EXT' ? 'ext' : 'mixed')

/**
 * 迁移与规整：旧稿没有拍摄安排字段时，按当前故事顺序补齐拍摄顺位，
 * 拍摄日默认归入“第 1 拍摄日”，组别按内外景推断；故事数组顺序与审阅状态不动。
 */
export function normalizeScript(script: Script): Script {
  script.scenes.forEach((scene, index) => {
    if (typeof scene.shootDay !== 'string' || !scene.shootDay.trim()) scene.shootDay = '第 1 拍摄日'
    if (scene.unit !== 'ext' && scene.unit !== 'int' && scene.unit !== 'mixed') scene.unit = unitFromIntExt(scene.intExt)
    if (typeof scene.shootOrder !== 'number' || !Number.isFinite(scene.shootOrder) || scene.shootOrder < 1) {
      scene.shootOrder = index + 1
    }
  })
  renumberSchedule(script)
  return script
}

/** 拍摄日排序键：“第 2 拍摄日”按数字 2，纯文字日名排在数字日之后。 */
export function dayRank(day: string): number {
  const match = String(day).match(/\d+/)
  return match ? Number(match[0]) : 1_000_000
}

/** 拍摄顺序：先按拍摄日（按日名中的数字排序，无名次按出现先后）、再按日内顺位；与 scenes 数组的故事顺序互不影响。 */
export function sortedByShoot(scenes: Scene[]): Scene[] {
  const dayOrder: string[] = []
  scenes.forEach((scene) => { if (!dayOrder.includes(scene.shootDay)) dayOrder.push(scene.shootDay) })
  const daySortKey = (day: string) => {
    const rank = dayRank(day)
    return rank * 1_000_000 + dayOrder.indexOf(day)
  }
  return [...scenes].sort((a, b) => {
    if (a.shootDay !== b.shootDay) return daySortKey(a.shootDay) - daySortKey(b.shootDay)
    return a.shootOrder - b.shootOrder
  })
}

export interface ShootDayGroup {
  day: string
  scenes: Scene[]
}

export function groupByShootDay(scenes: Scene[]): ShootDayGroup[] {
  const groups: ShootDayGroup[] = []
  sortedByShoot(scenes).forEach((scene) => {
    const group = groups.find((item) => item.day === scene.shootDay)
    if (group) group.scenes.push(scene)
    else groups.push({ day: scene.shootDay, scenes: [scene] })
  })
  return groups
}

/** 按当前（拍摄日、顺位）排布稳定排序后，把全部场次的顺位重排为 1..N。 */
function renumberSchedule(script: Script) {
  const sorted = sortedByShoot(script.scenes)
  sorted.forEach((scene, index) => { scene.shootOrder = index + 1 })
}

function initialState(): ContinuityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ContinuityState
      if (parsed.script?.scenes?.length) {
        normalizeScript(parsed.script)
        // 旧版本快照同样补齐拍摄安排默认值，避免版本差异里出现“无中生有”的拍摄字段。
        parsed.versions?.forEach((version) => { if (version.script?.scenes?.length) normalizeScript(version.script) })
        // 迁移时把已有审阅结论锚定到当前故事顺序：不改变状态，只补上依据快照，
        // 之后只有依据真正变化才会退回待审。
        const warnings = deriveWarnings(parsed.script)
        parsed.reviews ??= {}
        warnings.forEach((warning) => {
          const review = parsed.reviews[warning.id]
          if (review && review.status !== 'pending' && !review.basis) review.basis = warning.basis
        })
        return parsed
      }
    }
  } catch {
    // Ignore an invalid local draft and restore the bundled example.
  }
  return { script: normalizeScript(clone(sampleScript)), reviews: {}, versions: [], updatedAt: new Date().toISOString() }
}

const sceneLabel = (script: Script, sceneId: string) => {
  const scene = script.scenes.find((item) => item.id === sceneId)
  return scene ? `场景 ${scene.number}《${scene.slug}》` : '已删除场次'
}

export function deriveWarnings(script: Script): WarningItem[] {
  const warnings: WarningItem[] = []
  const sceneIndex = (sceneId: string) => script.scenes.findIndex((scene) => scene.id === sceneId)
  const charactersSeen = new Set<string>()
  const propsSeen = new Set<string>()

  script.scenes.forEach((scene, index) => {
    scene.characterIds.forEach((characterId) => {
      const character = script.characters.find((item) => item.id === characterId)
      if (!character) return
      const introducedAt = sceneIndex(character.introducedSceneId)
      if (index > 0 && !charactersSeen.has(characterId) && introducedAt >= index) {
        const introducedNumber = script.scenes[introducedAt]?.number ?? '未设置'
        warnings.push({
          id: `character-${scene.id}-${characterId}`,
          type: 'character',
          severity: index > 1 ? 'error' : 'warning',
          sceneId: scene.id,
          title: `${character.name}突然出现`,
          detail: `角色在场景 ${scene.number} 首次出现，但前序场景没有建立其身份、关系或到场铺垫。`,
          suggestion: `在更早场景补充提及、声音或到场动作，并把“首次建立”场景改为相应场次。`,
          basis: `故事顺序第 ${index + 1} 场为角色“${character.name}”的首次出场；资料库中其“首次建立”标记为场景 ${introducedNumber}（故事顺序第 ${introducedAt + 1} 场），晚于或等于本场。`
        })
      }
      charactersSeen.add(characterId)
    })

    scene.propIds.forEach((propId) => {
      const prop = script.props.find((item) => item.id === propId)
      if (!prop) return
      const introducedAt = sceneIndex(prop.introducedSceneId)
      if (!propsSeen.has(propId) && introducedAt > index) {
        warnings.push({
          id: `prop-${scene.id}-${propId}`,
          type: 'prop',
          severity: 'error',
          sceneId: scene.id,
          title: `${prop.name}尚未提前建立`,
          detail: `道具在场景 ${scene.number} 已出现，但首次建立被标记在场景 ${script.scenes[introducedAt]?.number ?? '未知'}。`,
          suggestion: '调整首次建立场景，或在当前场景加入来源、交接动作与持有人反应。',
          basis: `故事顺序第 ${index + 1} 场首次出现道具“${prop.name}”；其“首次建立”标记为场景 ${script.scenes[introducedAt]?.number ?? '未设置'}（故事顺序第 ${introducedAt + 1} 场），晚于本场。`
        })
      }
      propsSeen.add(propId)
    })

    Object.entries(scene.costumes).forEach(([characterId, wardrobeId]) => {
      const wardrobe = script.wardrobes.find((item) => item.id === wardrobeId)
      const character = script.characters.find((item) => item.id === characterId)
      if (!wardrobe || !character) return
      if (!wardrobe.timePeriods.includes(scene.dayNight)) {
        warnings.push({
          id: `wardrobe-${scene.id}-${characterId}-${wardrobeId}`,
          type: 'wardrobe',
          severity: 'warning',
          sceneId: scene.id,
          title: `${character.name}服装与时间冲突`,
          detail: `“${wardrobe.name}”只配置用于 ${wardrobe.timePeriods.join('、')}，本场标记为“${scene.dayNight}”。`,
          suggestion: '确认是否跨越时间连续拍摄；如需延续服装，请把当前时段加入服装适用范围。',
          basis: `场景 ${scene.number} 中“${character.name}”穿着“${wardrobe.name}”；该服装适用时段为 ${wardrobe.timePeriods.join('、')}，本场日夜为“${scene.dayNight}”。服装判断与拍摄顺序无关。`
        })
      }
    })

    if (index > 0 && script.scenes[index - 1].storyTime && scene.storyTime) {
      const previous = script.scenes[index - 1]
      const previousDay = previous.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      const currentDay = scene.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      if (previousDay && currentDay && Number(currentDay) < Number(previousDay)) {
        warnings.push({
          id: `timeline-${scene.id}`,
          type: 'timeline',
          severity: 'error',
          sceneId: scene.id,
          title: '时间线出现倒退',
          detail: `上一场为第 ${previousDay} 天，本场却标记为第 ${currentDay} 天，可能造成观看顺序混乱。`,
          suggestion: '调整故事时间，或明确使用倒叙并在场次摘要中标注时间跳转。',
          basis: `故事顺序中，本场（场景 ${scene.number}，第 ${currentDay} 天）紧接场景 ${previous.number}（第 ${previousDay} 天）之后，天数倒退。`
        })
      }
    }
  })
  return warnings
}

/* ------------------------------------------------------------------ */
/* 审阅结论的依据比对：只有故事侧变化导致依据改变时，结论才退回待审。       */
/* ------------------------------------------------------------------ */

interface StoryFact {
  key: string
  types: WarningType[]
  sceneId?: string
  refId?: string
  detail: string
}

const fieldLabels: Partial<Record<keyof Scene, string>> = {
  dayNight: '日夜时段',
  storyTime: '故事时间',
  characterIds: '出场角色',
  propIds: '出场道具',
  costumes: '服装安排'
}
const fieldFactTypes: Record<string, WarningType[]> = {
  dayNight: ['wardrobe', 'timeline'],
  storyTime: ['timeline'],
  characterIds: ['character'],
  propIds: ['prop'],
  costumes: ['wardrobe']
}

function collectStoryFacts(before: Script, after: Script): StoryFact[] {
  const facts: StoryFact[] = []
  const beforeById = new Map(before.scenes.map((scene) => [scene.id, scene]))
  const afterById = new Map(after.scenes.map((scene) => [scene.id, scene]))

  let orderChanged = false
  after.scenes.forEach((scene, index) => {
    const oldIndex = before.scenes.findIndex((item) => item.id === scene.id)
    if (oldIndex >= 0 && oldIndex !== index) {
      orderChanged = true
      facts.push({
        key: `order-${scene.id}`,
        types: ['character', 'prop', 'timeline'],
        sceneId: scene.id,
        detail: `“${sceneLabel(after, scene.id)}”在故事顺序中由第 ${oldIndex + 1} 位移至第 ${index + 1} 位`
      })
    }
  })

  after.scenes.forEach((scene) => {
    const previous = beforeById.get(scene.id)
    if (!previous) {
      facts.push({ key: `add-${scene.id}`, types: ['character', 'prop', 'timeline'], sceneId: scene.id, detail: `新增“${sceneLabel(after, scene.id)}”，首次出场、道具建立与相邻时间关系随之变化` })
      return
    }
    ;(Object.keys(fieldLabels) as Array<keyof typeof fieldLabels>).forEach((field) => {
      const oldValue = JSON.stringify(previous[field])
      const newValue = JSON.stringify(scene[field])
      if (oldValue !== newValue) {
        facts.push({
          key: `field-${scene.id}-${String(field)}`,
          types: fieldFactTypes[String(field)],
          sceneId: scene.id,
          detail: `“${sceneLabel(after, scene.id)}”的${fieldLabels[field]}已修改`
        })
      }
    })
  })

  before.scenes.forEach((scene) => {
    if (!afterById.has(scene.id)) {
      facts.push({ key: `delete-${scene.id}`, types: ['character', 'prop', 'timeline'], detail: `删除“${sceneLabel(before, scene.id)}”，其后场次的首次出场、道具建立与相邻时间关系随之变化` })
    }
  })

  if (orderChanged) {
    facts.unshift({ key: 'story-order', types: ['character', 'prop', 'timeline'], detail: '故事顺序已调整，角色首次出场、道具首次建立和前后场时间关系需要重新核对' })
  }

  after.characters.forEach((character) => {
    const previous = before.characters.find((item) => item.id === character.id)
    if (previous && previous.introducedSceneId !== character.introducedSceneId) {
      facts.push({
        key: `character-intro-${character.id}`,
        types: ['character'],
        refId: character.id,
        detail: `角色“${character.name}”的首次建立场次改为场景 ${afterById.get(character.introducedSceneId)?.number ?? '未设置'}`
      })
    }
  })

  after.props.forEach((prop) => {
    const previous = before.props.find((item) => item.id === prop.id)
    if (previous && previous.introducedSceneId !== prop.introducedSceneId) {
      facts.push({
        key: `prop-intro-${prop.id}`,
        types: ['prop'],
        refId: prop.id,
        detail: `道具“${prop.name}”的首次建立场次改为场景 ${afterById.get(prop.introducedSceneId)?.number ?? '未设置'}`
      })
    }
  })

  after.wardrobes.forEach((wardrobe) => {
    const previous = before.wardrobes.find((item) => item.id === wardrobe.id)
    if (previous && JSON.stringify(previous.timePeriods) !== JSON.stringify(wardrobe.timePeriods)) {
      facts.push({
        key: `wardrobe-periods-${wardrobe.id}`,
        types: ['wardrobe'],
        refId: wardrobe.id,
        detail: `服装“${wardrobe.name}”的适用时段改为 ${wardrobe.timePeriods.join('、')}`
      })
    }
  })

  return facts
}

export function reconcileReviews(before: Script, after: Script, current: WarningItem[], reviews: Record<string, WarningReview>): Record<string, WarningReview> {
  const facts = collectStoryFacts(before, after)
  if (!facts.length) return reviews

  let changed = false
  const next = { ...reviews }
  current.forEach((warning) => {
    const review = next[warning.id]
    if (!review || review.status === 'pending') return
    if (review.basis === warning.basis) return

    const related = facts.filter((fact) => {
      if (!fact.types.includes(warning.type)) return false
      if (fact.sceneId && fact.sceneId !== warning.sceneId && fact.key !== 'story-order') {
        // 顺序类全局事实对所有角色/道具/时间线警告都可能相关，其余带场景的事实只关联本场。
        if (!fact.key.startsWith('order-') && !fact.key.startsWith('add-') && !fact.key.startsWith('delete-')) return false
      }
      if (fact.refId && !warning.id.includes(fact.refId)) return false
      return true
    })
    const detail = related.length
      ? related.map((fact) => fact.detail).join('；')
      : '故事顺序或连续性要素已变化，原有审阅依据不再成立'
    const previousWord = review.status === 'accepted' ? '已接受' : '已忽略'
    changed = true
    next[warning.id] = {
      ...review,
      status: 'pending',
      reopenReason: `依据已变化：${detail}。原${previousWord}结论退回待审，回复记录保留。`,
      reopenedAt: new Date().toISOString()
    }
  })
  return changed ? next : reviews
}

export function diffScript(base: Script, current: Script): DiffItem[] {
  const fields: Array<{ key: keyof Scene; label: string; format?: (scene: Scene) => string }> = [
    { key: 'slug', label: '场名' },
    { key: 'synopsis', label: '摘要' },
    { key: 'intExt', label: '内外景' },
    { key: 'location', label: '地点' },
    { key: 'dayNight', label: '日夜' },
    { key: 'storyTime', label: '故事时间' },
    { key: 'pageLength', label: '页数' },
    { key: 'revision', label: '修订色' },
    { key: 'status', label: '状态' },
    { key: 'reason', label: '修改理由' },
    { key: 'shootDay', label: '拍摄日' },
    { key: 'unit', label: '拍摄组别', format: (scene) => unitLabel(scene.unit) },
    { key: 'shootOrder', label: '拍摄顺位' }
  ]
  const result: DiffItem[] = []
  const sceneKey = (scene: Scene) => `${scene.number}|${scene.slug}`
  const baseByKey = new Map(base.scenes.map((scene) => [sceneKey(scene), scene]))
  current.scenes.forEach((scene) => {
    const previous = baseByKey.get(sceneKey(scene)) ?? base.scenes.find((item) => item.id === scene.id)
    if (!previous) {
      result.push({ id: `new-${scene.id}`, sceneNumber: scene.number, field: '场次', before: '不存在', after: `${scene.intExt}. ${scene.location} — ${scene.dayNight}` })
      return
    }
    fields.forEach(({ key, label, format }) => {
      const beforeText = String(format ? format(previous) : (previous[key] ?? ''))
      const afterText = String(format ? format(scene) : (scene[key] ?? ''))
      if (beforeText !== afterText) result.push({ id: `${scene.id}-${String(key)}`, sceneNumber: scene.number, field: label, before: beforeText, after: afterText })
    })
  })
  base.scenes.forEach((scene) => {
    if (!current.scenes.some((item) => item.id === scene.id || sceneKey(item) === sceneKey(scene))) {
      result.push({ id: `deleted-${scene.id}`, sceneNumber: scene.number, field: '场次', before: `${scene.intExt}. ${scene.location} — ${scene.dayNight}`, after: '已删除' })
    }
  })
  return result
}

export function useContinuityStore() {
  const [state, setState] = useState<ContinuityState>(initialState)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const undoRef = useRef<Script[]>([])
  const redoRef = useRef<Script[]>([])
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    setSaveStatus('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      setSaveStatus('saved')
    }, 160)
    return () => window.clearTimeout(saveTimer.current)
  }, [state])

  const applyScript = useCallback((producer: (script: Script) => Script) => {
    setState((previous) => {
      const before = clone(previous.script)
      const next = normalizeScript(producer(clone(before)))
      undoRef.current.push(before)
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      const reviews = reconcileReviews(before, next, deriveWarnings(next), previous.reviews)
      return { ...previous, script: next, reviews, updatedAt: new Date().toISOString() }
    })
  }, [])

  const mutate = useCallback((mutator: (script: Script) => void) => {
    applyScript((script) => { mutator(script); return script })
  }, [applyScript])

  const undo = useCallback(() => {
    setState((previous) => {
      const target = undoRef.current.pop()
      if (!target) return previous
      normalizeScript(target)
      redoRef.current.push(clone(previous.script))
      const reviews = reconcileReviews(previous.script, target, deriveWarnings(target), previous.reviews)
      return { ...previous, script: target, reviews, updatedAt: new Date().toISOString() }
    })
  }, [])

  const redo = useCallback(() => {
    setState((previous) => {
      const target = redoRef.current.pop()
      if (!target) return previous
      normalizeScript(target)
      undoRef.current.push(clone(previous.script))
      const reviews = reconcileReviews(previous.script, target, deriveWarnings(target), previous.reviews)
      return { ...previous, script: target, reviews, updatedAt: new Date().toISOString() }
    })
  }, [])

  const updateScriptField = useCallback((field: 'title' | 'writer' | 'draft', value: string) => {
    mutate((script) => { script[field] = value })
  }, [mutate])

  const updateScene = useCallback((sceneId: string, field: keyof Scene, value: Scene[keyof Scene]) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (scene) (scene as unknown as Record<string, unknown>)[field] = value
    })
  }, [mutate])

  const toggleSceneRelation = useCallback((sceneId: string, field: 'characterIds' | 'propIds', itemId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const values = scene[field]
      scene[field] = values.includes(itemId) ? values.filter((value) => value !== itemId) : [...values, itemId]
    })
  }, [mutate])

  const setCostume = useCallback((sceneId: string, characterId: string, wardrobeId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (!wardrobeId) delete scene.costumes[characterId]
      else scene.costumes[characterId] = wardrobeId
    })
  }, [mutate])

  /** 故事顺序上移/下移：只调整 scenes 数组，连续性结论会随之重算。 */
  const moveScene = useCallback((sceneId: string, direction: -1 | 1) => {
    mutate((script) => {
      const index = script.scenes.findIndex((scene) => scene.id === sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= script.scenes.length) return
      const [scene] = script.scenes.splice(index, 1)
      script.scenes.splice(target, 0, scene)
    })
  }, [mutate])

  const addScene = useCallback(() => {
    const sceneId = id('scene')
    mutate((script) => {
      const flat = sortedByShoot(script.scenes)
      const lastDay = flat[flat.length - 1]?.shootDay ?? '第 1 拍摄日'
      const intExt: Scene['intExt'] = 'INT'
      script.scenes.push({
        id: sceneId, number: String(script.scenes.length + 1), slug: '未命名场景', synopsis: '', intExt, location: '待填写', dayNight: '白天', storyTime: `第 1 天`, pageLength: 1,
        characterIds: [], propIds: [], costumes: {}, revision: 'white', status: 'draft', reason: '',
        shootDay: lastDay, unit: unitFromIntExt(intExt), shootOrder: script.scenes.length + 1
      })
    })
    return sceneId
  }, [mutate])

  const deleteScene = useCallback((sceneId: string) => {
    if (state.script.scenes.length <= 1) return
    mutate((script) => { script.scenes = script.scenes.filter((scene) => scene.id !== sceneId) })
  }, [mutate, state.script.scenes.length])

  /* ---------------- 拍摄安排：只动拍摄日 / 组别 / 顺位，不碰故事顺序 ---------------- */

  const updateSceneUnit = useCallback((sceneId: string, unit: UnitGroup) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (scene) scene.unit = unit
    })
  }, [mutate])

  /** 修改场次所属拍摄日：该场移动到目标拍摄日的队尾，再统一重排顺位。 */
  const setSceneShootDay = useCallback((sceneId: string, day: string) => {
    const trimmed = day.trim()
    if (!trimmed) return
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene || scene.shootDay === trimmed) {
        if (scene) scene.shootDay = trimmed
        return
      }
      scene.shootDay = trimmed
      // 稳定排序：同拍摄日内把该场排到最后（借助一个足够大的临时顺位）。
      const sameDay = script.scenes.filter((item) => item.shootDay === trimmed && item.id !== sceneId)
      scene.shootOrder = sameDay.reduce((max, item) => Math.max(max, item.shootOrder), 0) + 0.5
      renumberSchedule(script)
    })
  }, [mutate])

  /** 在拍摄时间轴上与相邻场次换位；跨拍摄日时继承目标位置所在的拍摄日。 */
  const moveSceneInSchedule = useCallback((sceneId: string, direction: -1 | 1) => {
    mutate((script) => {
      const flat = sortedByShoot(script.scenes)
      const index = flat.findIndex((scene) => scene.id === sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= flat.length) return
      const slotDays = flat.map((scene) => scene.shootDay)
      const [scene] = flat.splice(index, 1)
      flat.splice(target, 0, scene)
      flat.forEach((item, slot) => {
        item.shootDay = slotDays[slot]
        item.shootOrder = slot + 1
      })
    })
  }, [mutate])

  /** 直接填写顺位（1..N）：等价于在拍摄时间轴上移动到该位置。 */
  const setSceneShootOrder = useCallback((sceneId: string, order: number) => {
    mutate((script) => {
      const flat = sortedByShoot(script.scenes)
      const index = flat.findIndex((scene) => scene.id === sceneId)
      const target = Math.min(flat.length, Math.max(1, Math.round(order))) - 1
      if (index < 0 || target === index) {
        if (index >= 0) flat[index].shootOrder = index + 1
        return
      }
      const slotDays = flat.map((scene) => scene.shootDay)
      const [scene] = flat.splice(index, 1)
      flat.splice(target, 0, scene)
      flat.forEach((item, slot) => {
        item.shootDay = slotDays[slot]
        item.shootOrder = slot + 1
      })
    })
  }, [mutate])

  /** 重命名拍摄日（拍摄日分组标题内联编辑）。 */
  const renameShootDay = useCallback((oldDay: string, day: string) => {
    const trimmed = day.trim()
    if (!trimmed || trimmed === oldDay) return
    mutate((script) => {
      script.scenes.forEach((scene) => { if (scene.shootDay === oldDay) scene.shootDay = trimmed })
      renumberSchedule(script)
    })
  }, [mutate])

  const addCharacter = useCallback(() => {
    mutate((script) => {
      script.characters.push({ id: id('char'), name: '新角色', actor: '待定', introducedSceneId: script.scenes[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateCharacter = useCallback((characterId: string, field: keyof Character, value: string) => {
    mutate((script) => {
      const item = script.characters.find((character) => character.id === characterId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addProp = useCallback(() => {
    mutate((script) => {
      script.props.push({ id: id('prop'), name: '新道具', introducedSceneId: script.scenes[0]?.id ?? '', ownerId: script.characters[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateProp = useCallback((propId: string, field: keyof Prop, value: string) => {
    mutate((script) => {
      const item = script.props.find((prop) => prop.id === propId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addWardrobe = useCallback(() => {
    mutate((script) => {
      script.wardrobes.push({ id: id('ward'), characterId: script.characters[0]?.id ?? '', name: '新服装', timePeriods: ['白天'], note: '' })
    })
  }, [mutate])

  const updateWardrobe = useCallback((wardrobeId: string, field: keyof Wardrobe, value: string | string[]) => {
    mutate((script) => {
      const item = script.wardrobes.find((wardrobe) => wardrobe.id === wardrobeId)
      if (item) {
        if (field === 'timePeriods') item.timePeriods = value as string[]
        else item[field] = value as never
      }
    })
  }, [mutate])

  const setReviewStatus = useCallback((warningId: string, status: WarningStatus) => {
    setState((previous) => {
      const existing = previous.reviews[warningId] ?? { status: 'pending' as WarningStatus, replies: [] }
      let review: WarningReview
      if (status === 'pending') {
        review = { status, replies: existing.replies }
      } else {
        const warning = deriveWarnings(previous.script).find((item) => item.id === warningId)
        // 记录结论所依据的判断内容；之后只有依据变化才会退回待审。
        review = { status, replies: existing.replies, basis: warning?.basis ?? existing.basis }
      }
      return {
        ...previous,
        reviews: { ...previous.reviews, [warningId]: review },
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  const addReply = useCallback((warningId: string, author: string, text: string) => {
    if (!text.trim()) return
    const reply: Reply = { id: id('reply'), author, text: text.trim(), createdAt: new Date().toISOString() }
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: {
          status: previous.reviews[warningId]?.status ?? 'pending',
          replies: [...(previous.reviews[warningId]?.replies ?? []), reply],
          basis: previous.reviews[warningId]?.basis,
          reopenReason: previous.reviews[warningId]?.reopenReason,
          reopenedAt: previous.reviews[warningId]?.reopenedAt
        }
      },
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const createVersion = useCallback((name: string) => {
    const version: Version = { id: id('version'), name: name.trim() || `版本 ${state.versions.length + 1}`, createdAt: new Date().toISOString(), script: clone(state.script) }
    setState((previous) => ({ ...previous, versions: [version, ...previous.versions] }))
    return version
  }, [state.script, state.versions.length])

  const restoreVersion = useCallback((versionId: string) => {
    setState((previous) => {
      const version = previous.versions.find((item) => item.id === versionId)
      if (!version) return previous
      const before = clone(previous.script)
      const next = normalizeScript(clone(version.script))
      undoRef.current.push(before)
      redoRef.current = []
      const reviews = reconcileReviews(before, next, deriveWarnings(next), previous.reviews)
      return { ...previous, script: next, reviews, updatedAt: new Date().toISOString() }
    })
  }, [])

  const reset = useCallback(() => {
    setState((previous) => {
      undoRef.current.push(clone(previous.script))
      redoRef.current = []
      return { ...previous, script: normalizeScript(clone(sampleScript)), reviews: {}, updatedAt: new Date().toISOString() }
    })
  }, [])

  return {
    state,
    saveStatus,
    warnings: deriveWarnings(state.script),
    updateScriptField,
    updateScene,
    toggleSceneRelation,
    setCostume,
    moveScene,
    addScene,
    deleteScene,
    updateSceneUnit,
    setSceneShootDay,
    moveSceneInSchedule,
    setSceneShootOrder,
    renameShootDay,
    addCharacter,
    updateCharacter,
    addProp,
    updateProp,
    addWardrobe,
    updateWardrobe,
    setReviewStatus,
    addReply,
    createVersion,
    restoreVersion,
    undo,
    redo,
    reset
  }
}
