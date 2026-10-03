export type RevisionColor = 'white' | 'blue' | 'pink' | 'yellow' | 'green' | 'goldenrod' | 'buff' | 'salmon' | 'cherry'
export type WarningStatus = 'pending' | 'accepted' | 'ignored'
export type WarningType = 'character' | 'prop' | 'wardrobe' | 'timeline'

export interface Character {
  id: string
  name: string
  actor: string
  introducedSceneId: string
  note: string
}

export interface Prop {
  id: string
  name: string
  introducedSceneId: string
  ownerId: string
  note: string
}

export interface Wardrobe {
  id: string
  characterId: string
  name: string
  timePeriods: string[]
  note: string
}

export interface Scene {
  id: string
  number: string
  slug: string
  synopsis: string
  intExt: 'INT' | 'EXT' | 'INT/EXT'
  location: string
  dayNight: string
  storyTime: string
  pageLength: number
  characterIds: string[]
  propIds: string[]
  costumes: Record<string, string>
  revision: RevisionColor
  status: 'draft' | 'review' | 'locked'
  reason: string
  /** 拍摄日，例如“第 1 拍摄日”；为空表示尚未排入拍摄计划。与故事顺序无关。 */
  shootDay: string
  /** 摄制组别，例如“外景组”“内景组”“A 组”。 */
  shootUnit: string
  /** 同一拍摄日 / 组别内的拍摄顺位，从 1 开始。 */
  shootOrder: number
}

export interface Script {
  title: string
  writer: string
  draft: string
  scenes: Scene[]
  characters: Character[]
  props: Prop[]
  wardrobes: Wardrobe[]
}

export interface WarningItem {
  id: string
  type: WarningType
  severity: 'error' | 'warning'
  sceneId: string
  title: string
  detail: string
  suggestion: string
  /** 该警告结论依赖的“依据签名”，只随故事侧数据变化；拍摄安排不参与。 */
  basis: string
  /** 警告主体（角色 / 道具 / 服装 id），便于变更说明定位。 */
  subjectId?: string
}

export interface Reply {
  id: string
  author: string
  text: string
  createdAt: string
}

export interface WarningReview {
  status: WarningStatus
  replies: Reply[]
  /** 审阅时该警告所依据的签名；与当前签名不一致时退回待审。 */
  basis?: string
  /** 退回待审之前的审阅结论。 */
  reopenedFrom?: WarningStatus
  /** 本次退回待审的依据说明（故事顺序/故事侧字段发生了什么变化）。 */
  reopenedReason?: string
  reopenedAt?: string
}

export interface Version {
  id: string
  name: string
  createdAt: string
  script: Script
}

export interface ContinuityState {
  script: Script
  reviews: Record<string, WarningReview>
  versions: Version[]
  updatedAt: string
}

export interface DiffItem {
  id: string
  sceneNumber: string
  field: string
  before: string
  after: string
}
