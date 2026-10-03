import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sampleScript } from './sample'
import type { Character, ContinuityState, DiffItem, Prop, Reply, Scene, Script, Version, Wardrobe, WarningItem, WarningReview } from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/**
 * 剧本里存在两套彼此独立的顺序：
 * - 故事顺序：`script.scenes` 数组的次序，决定连续性结论；
 * - 拍摄顺序：由每场的 shootDay / shootUnit / shootOrder 派生，只影响拍摄安排。
 * 只改拍摄安排时不重算任何连续性结论；只有故事侧数据变化才会重审警告。
 */
export interface ShootGroup {
  key: string
  day: string
  unit: string
  scenes: Scene[]
}

/** 迁移旧稿：补齐拍摄字段（默认排入“第 1 拍摄日·外景组”，沿用数组次序），故事顺序不动。 */
function migrateScript(script: Script): Script {
  script.scenes.forEach((scene, index) => {
    if (typeof (scene as Partial<Scene>).shootDay !== 'string') scene.shootDay = '第 1 拍摄日'
    if (typeof (scene as Partial<Scene>).shootUnit !== 'string') scene.shootUnit = '外景组'
    if (typeof (scene as Partial<Scene>).shootOrder !== 'number') scene.shootOrder = index + 1
  })
  return script
}

/** 旧稿打开时迁移：补拍摄顺位，并为已有警告回填依据签名，原审阅状态一律不变。 */
export function migrateState(parsed: ContinuityState): ContinuityState {
  migrateScript(parsed.script)
  const basisById = new Map(deriveWarnings(parsed.script).map((warning) => [warning.id, warning.basis]))
  for (const [warningId, review] of Object.entries(parsed.reviews)) {
    // 为仍存在的警告静默回填依据；不改变任何审阅状态，也不产生退回说明。
    if (!review.basis && basisById.has(warningId)) review.basis = basisById.get(warningId)
  }
  return parsed
}

function initialState(): ContinuityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ContinuityState
      if (parsed.script?.scenes?.length) return migrateState(parsed)
    }
  } catch {
    // Ignore an invalid local draft and restore the bundled example.
  }
  return { script: clone(sampleScript), reviews: {}, versions: [], updatedAt: new Date().toISOString() }
}

/** 故事顺序中前一场（连续性检查以数组次序为准）。 */
function previousStoryScene(scenes: Scene[], index: number): Scene | undefined {
  return index > 0 ? scenes[index - 1] : undefined
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
        warnings.push({
          id: `character-${scene.id}-${characterId}`,
          type: 'character',
          severity: index > 1 ? 'error' : 'warning',
          sceneId: scene.id,
          subjectId: characterId,
          title: `${character.name}突然出现`,
          detail: `角色在场景 ${scene.number} 首次出现，但前序场景没有建立其身份、关系或到场铺垫。`,
          suggestion: `在更早场景补充提及、声音或到场动作，并把“首次建立”场景改为相应场次。`,
          basis: `character|${characterId}|at:${index}|intro:${introducedAt}`
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
          subjectId: propId,
          title: `${prop.name}尚未提前建立`,
          detail: `道具在场景 ${scene.number} 已出现，但首次建立被标记在场景 ${script.scenes[introducedAt]?.number ?? '未知'}。`,
          suggestion: '调整首次建立场景，或在当前场景加入来源、交接动作与持有人反应。',
          basis: `prop|${propId}|at:${index}|intro:${introducedAt}`
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
          subjectId: wardrobeId,
          title: `${character.name}服装与时间冲突`,
          detail: `“${wardrobe.name}”只配置用于 ${wardrobe.timePeriods.join('、')}，本场标记为“${scene.dayNight}”。`,
          suggestion: '确认是否跨越时间连续拍摄；如需延续服装，请把当前时段加入服装适用范围。',
          basis: `wardrobe|${scene.id}|${characterId}|${wardrobeId}|${scene.dayNight}|${[...wardrobe.timePeriods].sort().join('/')}`
        })
      }
    })

    const previous = previousStoryScene(script.scenes, index)
    if (previous?.storyTime && scene.storyTime) {
      const previousDay = previous.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      const currentDay = scene.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      if (previousDay && currentDay && Number(currentDay) < Number(previousDay)) {
        warnings.push({
          id: `timeline-${scene.id}`,
          type: 'timeline',
          severity: 'error',
          sceneId: scene.id,
          title: '时间线出现倒退',
          detail: `上一场（场景 ${previous.number}）为第 ${previousDay} 天，本场却标记为第 ${currentDay} 天，可能造成观看顺序混乱。`,
          suggestion: '调整故事时间，或明确使用倒叙并在场次摘要中标注时间跳转。',
          basis: `timeline|${scene.id}|prev:${previous.id}|${previousDay}>${currentDay}`
        })
      }
    }
  })
  return warnings
}

/**
 * 根据旧剧本与当前警告，解释一条警告为何需要退回待审。
 * 只有故事侧的依据发生变化才返回说明；拍摄安排（拍摄日/组别/顺位）不会走到这里。
 */
function buildReopenReason(warning: WarningItem, oldScript: Script, currentScript: Script): string {
  const position = (script: Script, sceneId: string) => script.scenes.findIndex((scene) => scene.id === sceneId) + 1
  const sceneName = (script: Script, sceneId: string) => {
    const scene = script.scenes.find((item) => item.id === sceneId)
    return scene ? `场景 ${scene.number}（${scene.slug}）` : '已删除场次'
  }

  if (warning.type === 'character' && warning.subjectId) {
    const character = currentScript.characters.find((item) => item.id === warning.subjectId)
      ?? oldScript.characters.find((item) => item.id === warning.subjectId)
    const parts: string[] = [`故事顺序调整后，${character?.name ?? '该角色'}首次出现的位置变为第 ${position(currentScript, warning.sceneId)} 场`]
    const introScene = character ? currentScript.scenes.find((scene) => scene.id === character.introducedSceneId) : undefined
    if (introScene) parts.push(`其“首次建立”${sceneName(currentScript, introScene.id)}仍排在后面`)
    return `${parts.join('，')}，请复核角色铺垫。`
  }

  if (warning.type === 'prop' && warning.subjectId) {
    const prop = currentScript.props.find((item) => item.id === warning.subjectId)
      ?? oldScript.props.find((item) => item.id === warning.subjectId)
    const parts: string[] = [`故事顺序调整后，${prop?.name ?? '该道具'}首次出现的位置变为第 ${position(currentScript, warning.sceneId)} 场`]
    const introScene = prop ? currentScript.scenes.find((scene) => scene.id === prop.introducedSceneId) : undefined
    if (introScene) parts.push(`其“首次建立”${sceneName(currentScript, introScene.id)}仍排在后面`)
    return `${parts.join('，')}，请复核道具来源。`
  }

  if (warning.type === 'timeline') {
    const currentIndex = currentScript.scenes.findIndex((scene) => scene.id === warning.sceneId)
    const currentPrev = previousStoryScene(currentScript.scenes, currentIndex)
    const currentScene = currentScript.scenes[currentIndex]
    if (currentPrev) {
      return `故事顺序调整后，本场（${currentScene?.slug ?? ''}）的前一场变为${sceneName(currentScript, currentPrev.id)}，故事日期对比依据改变，请复核时间线。`
    }
    return '故事顺序或故事时间调整后，时间线倒退判断的依据改变，请复核。'
  }

  if (warning.type === 'wardrobe') {
    const newScene = currentScript.scenes.find((scene) => scene.id === warning.sceneId)
    if (newScene) return `本场日夜标记或服装适用时段发生变化（当前为“${newScene.dayNight}”），请重新核对服装连续性。`
    return '服装适用时段或本场日夜发生变化，请重新核对。'
  }

  return '故事侧数据调整后，该警告的判断依据发生变化，请重新审阅。'
}

/**
 * 故事侧变更后的审阅调和：
 * - 已接受/已忽略且依据签名变化的警告 → 退回待审，并记录原结论与依据说明；
 * - 依据未变（含只改拍摄安排的情形，那种情形不会调用本函数）→ 结论保留；
 * - 已消失的警告保留其审阅记录，再次出现且依据已变时再退回。
 */
export function reconcileReviews(prev: ContinuityState['reviews'], nextWarnings: WarningItem[], oldScript: Script, nextScript: Script): ContinuityState['reviews'] {
  const reviews = clone(prev)
  nextWarnings.forEach((warning) => {
    const review = reviews[warning.id]
    if (!review) return
    if (!review.basis) {
      // 旧稿迁移无法补到依据（此前警告已消失），如今重新出现需重新审阅。
      if (review.status !== 'pending') {
        reviews[warning.id] = {
          ...review,
          status: 'pending',
          reopenedFrom: review.status,
          reopenedReason: buildReopenReason(warning, oldScript, nextScript),
          reopenedAt: new Date().toISOString()
        }
      } else {
        review.basis = warning.basis
      }
      return
    }
    if (review.status !== 'pending' && review.basis !== warning.basis) {
      reviews[warning.id] = {
        ...review,
        status: 'pending',
        reopenedFrom: review.status,
        reopenedReason: buildReopenReason(warning, oldScript, nextScript),
        reopenedAt: new Date().toISOString()
      }
    }
  })
  return reviews
}

export function diffScript(base: Script, current: Script): DiffItem[] {
  const fields: Array<{ key: keyof Scene; label: string }> = [
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
    { key: 'shootUnit', label: '组别' },
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
    fields.forEach(({ key, label }) => {
      const before = String(previous[key] ?? '')
      const after = String(scene[key] ?? '')
      if (before !== after) result.push({ id: `${scene.id}-${String(key)}`, sceneNumber: scene.number, field: label, before, after })
    })
  })
  base.scenes.forEach((scene) => {
    if (!current.scenes.some((item) => item.id === scene.id || sceneKey(item) === sceneKey(scene))) {
      result.push({ id: `deleted-${scene.id}`, sceneNumber: scene.number, field: '场次', before: `${scene.intExt}. ${scene.location} — ${scene.dayNight}`, after: '已删除' })
    }
  })
  return result
}

/** 派生拍摄顺序：先按拍摄日、再按组别，组内按拍摄顺位；未排期的场次单独成组。 */
export function buildShootSchedule(script: Script): { groups: ShootGroup[]; storyIndexById: Map<string, number> } {
  const storyIndexById = new Map(script.scenes.map((scene, index) => [scene.id, index]))
  const dayRank = (day: string) => Number(day.match(/(\d+)/)?.[1] ?? Number.POSITIVE_INFINITY)
  const unitRank = (unit: string) => {
    if (unit.includes('外景')) return 0
    if (unit.includes('内景')) return 1
    if (unit === 'A 组' || unit === 'A组') return 2
    if (unit === 'B 组' || unit === 'B组') return 3
    return 4
  }

  const groups = new Map<string, ShootGroup>()
  script.scenes.forEach((scene) => {
    const day = scene.shootDay.trim()
    const unit = scene.shootUnit.trim()
    const key = `${day}||${unit}`
    if (!groups.has(key)) groups.set(key, { key, day, unit, scenes: [] })
    groups.get(key)!.scenes.push(scene)
  })

  const result = [...groups.values()]
  result.forEach((group) => {
    group.scenes.sort((a, b) => a.shootOrder - b.shootOrder || (storyIndexById.get(a.id) ?? 0) - (storyIndexById.get(b.id) ?? 0))
  })
  result.sort((a, b) => {
    const unscheduled = Number(!a.day) - Number(!b.day)
    if (unscheduled) return unscheduled
    const day = dayRank(a.day) - dayRank(b.day) || a.day.localeCompare(b.day, 'zh-CN')
    if (day) return day
    return unitRank(a.unit) - unitRank(b.unit) || a.unit.localeCompare(b.unit, 'zh-CN')
  })
  return { groups: result, storyIndexById }
}

interface HistoryEntry {
  script: Script
  reviews: ContinuityState['reviews']
}

export function useContinuityStore() {
  const [state, setState] = useState<ContinuityState>(initialState)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const undoRef = useRef<HistoryEntry[]>([])
  const redoRef = useRef<HistoryEntry[]>([])
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

  /** 故事侧修改：重算警告并调和审阅状态（受影响的已审警告退回待审）。 */
  const mutate = useCallback((mutator: (script: Script) => void) => {
    setState((previous) => {
      const next = clone(previous.script)
      mutator(next)
      const nextWarnings = deriveWarnings(next)
      undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      return {
        ...previous,
        script: next,
        reviews: reconcileReviews(previous.reviews, nextWarnings, previous.script, next),
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  /** 拍摄侧修改：只动拍摄日/组别/顺位，连续性结论与审阅状态完全不变。 */
  const mutateShooting = useCallback((mutator: (script: Script) => void) => {
    setState((previous) => {
      const next = clone(previous.script)
      mutator(next)
      undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      return { ...previous, script: next, updatedAt: new Date().toISOString() }
    })
  }, [])

  const undo = useCallback(() => {
    setState((previous) => {
      const target = undoRef.current.pop()
      if (!target) return previous
      redoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      return { ...previous, script: target.script, reviews: target.reviews, updatedAt: new Date().toISOString() }
    })
  }, [])

  const redo = useCallback(() => {
    setState((previous) => {
      const target = redoRef.current.pop()
      if (!target) return previous
      undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      return { ...previous, script: target.script, reviews: target.reviews, updatedAt: new Date().toISOString() }
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

  /** 故事顺序上移/下移：会改变连续性依据，受影响的警告回待审。 */
  const moveScene = useCallback((sceneId: string, direction: -1 | 1) => {
    mutate((script) => {
      const index = script.scenes.findIndex((scene) => scene.id === sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= script.scenes.length) return
      const [scene] = script.scenes.splice(index, 1)
      script.scenes.splice(target, 0, scene)
    })
  }, [mutate])

  /** 拍摄顺位上移/下移：只与同一拍摄日、同组别的场次交换，不碰故事顺序。 */
  const moveShootScene = useCallback((sceneId: string, direction: -1 | 1) => {
    mutateShooting((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const peers = script.scenes
        .filter((item) => item.shootDay.trim() === scene.shootDay.trim() && item.shootUnit.trim() === scene.shootUnit.trim())
        .sort((a, b) => a.shootOrder - b.shootOrder || script.scenes.indexOf(a) - script.scenes.indexOf(b))
      const pos = peers.findIndex((item) => item.id === sceneId)
      peers.forEach((peer, rank) => { peer.shootOrder = rank + 1 })
      const target = pos + direction
      if (pos < 0 || target < 0 || target >= peers.length) return
      const moving = peers[pos].shootOrder
      peers[pos].shootOrder = peers[target].shootOrder
      peers[target].shootOrder = moving
    })
  }, [mutateShooting])

  /** 修改拍摄安排（拍摄日 / 组别 / 顺位），不重算连续性。 */
  const updateShootField = useCallback((sceneId: string, field: 'shootDay' | 'shootUnit' | 'shootOrder', value: string | number) => {
    mutateShooting((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (scene) (scene as unknown as Record<string, unknown>)[field] = value
    })
  }, [mutateShooting])

  const addScene = useCallback(() => {
    const sceneId = id('scene')
    mutate((script) => {
      const number = String(script.scenes.length + 1)
      const maxOrder = script.scenes.reduce((max, scene) => Math.max(max, scene.shootOrder || 0), 0)
      script.scenes.push({
        id: sceneId, number, slug: '未命名场景', synopsis: '', intExt: 'INT', location: '待填写', dayNight: '白天', storyTime: `第 1 天`, pageLength: 1,
        characterIds: [], propIds: [], costumes: {}, revision: 'white', status: 'draft', reason: '',
        shootDay: '', shootUnit: '', shootOrder: maxOrder + 1
      })
    })
    return sceneId
  }, [mutate])

  const deleteScene = useCallback((sceneId: string) => {
    if (state.script.scenes.length <= 1) return
    mutate((script) => { script.scenes = script.scenes.filter((scene) => scene.id !== sceneId) })
  }, [mutate, state.script.scenes.length])

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

  const setReviewStatus = useCallback((warningId: string, status: WarningReview['status']) => {
    setState((previous) => {
      const basis = deriveWarnings(previous.script).find((warning) => warning.id === warningId)?.basis ?? previous.reviews[warningId]?.basis
      const existing = previous.reviews[warningId] ?? { replies: [] }
      const review: WarningReview = status === 'pending'
        ? { status, replies: existing.replies ?? [], basis }
        : { status, replies: existing.replies ?? [], basis, reopenedFrom: undefined, reopenedReason: undefined, reopenedAt: undefined }
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
          ...(previous.reviews[warningId]?.basis ? { basis: previous.reviews[warningId]!.basis } : {}),
          ...(previous.reviews[warningId]?.reopenedFrom ? { reopenedFrom: previous.reviews[warningId]!.reopenedFrom, reopenedReason: previous.reviews[warningId]!.reopenedReason, reopenedAt: previous.reviews[warningId]!.reopenedAt } : {})
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
    const version = state.versions.find((item) => item.id === versionId)
    if (!version) return
    mutate((script) => {
      const restored = migrateScript(clone(version.script))
      script.scenes = restored.scenes
      script.characters = restored.characters
      script.props = restored.props
      script.wardrobes = restored.wardrobes
      script.title = restored.title
      script.writer = restored.writer
      script.draft = restored.draft
    })
  }, [mutate, state.versions])

  const reset = useCallback(() => {
    mutate((script) => { Object.assign(script, clone(sampleScript)) })
    setState((previous) => ({ ...previous, reviews: {} }))
  }, [mutate])

  const schedule = useMemo(() => buildShootSchedule(state.script), [state.script])

  return {
    state,
    saveStatus,
    warnings: deriveWarnings(state.script),
    schedule,
    updateScriptField,
    updateScene,
    toggleSceneRelation,
    setCostume,
    moveScene,
    moveShootScene,
    updateShootField,
    addScene,
    deleteScene,
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
