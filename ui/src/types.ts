export interface Ref {
  id: number
  name: string
}

export interface StatusRef extends Ref {
  isClosed: boolean
}

export interface IssueSummary {
  id: number
  subject: string
  project: Ref | null
  tracker: Ref | null
  status: StatusRef
  priority: Ref | null
  assignedTo: Ref | null
  author: Ref | null
  parentId: number | null
  doneRatio: number | null
  dueDate: string | null
  createdOn: string | null
  updatedOn: string | null
  url: string
}

export interface Journal {
  id: number
  user: Ref | null
  createdOn: string | null
  notes: string
  private: boolean
  details: { property: string; name: string; oldValue: string | null; newValue: string | null }[]
}

export interface IssueDetail extends IssueSummary {
  description: string
  startDate: string | null
  journals: Journal[]
  attachments: { id: number; filename: string; filesize: number; contentType: string; url: string }[]
  relations: { id: number; type: string; issueId: number; issueToId: number }[]
  children: { id: number; subject: string; tracker: Ref | null }[]
  allowedStatuses: StatusRef[] | null
}

export interface Chip {
  kind: 'filter' | 'text'
  field?: string
  op?: string
  values?: string[]
  text?: string
  negated?: boolean
  raw: string
}

export interface QueryError {
  token: string
  code: string
  value?: string
  suggestion?: string
}

export interface ResultMeta {
  chips: Chip[]
  errors: QueryError[]
  note?: string
}

export interface SearchResult extends ResultMeta {
  issues: IssueSummary[]
  total: number
  offset: number
  limit: number
  direct?: number
}

export interface BoardResult extends ResultMeta {
  columns: { status: StatusRef; issues: IssueSummary[]; total: number }[]
  perColumn: number
}

export interface FieldMeta {
  key: string
  aliases: string[]
  kind: string
}

export interface Meta {
  baseUrl: string
  user: { id: number; login: string; name: string; admin: boolean }
  projects: { id: number; identifier: string; name: string; parentId: number | null }[]
  /** projects the current user belongs to (absent on older backends) */
  myProjectIds?: number[]
  statuses: StatusRef[]
  trackers: Ref[]
  priorities: Ref[]
  queries: { id: number; name: string; isPublic: boolean; projectId: number | null }[]
  fields: FieldMeta[]
}

export interface ProjectOptions {
  members: { id: number; name: string; group: boolean }[]
  versions: { id: number; name: string; status: string }[]
  categories: Ref[]
  customFields: Ref[]
}

export interface SavedView {
  name: string
  expr?: string
  tab?: 'board' | 'list'
  sort?: string
}

export interface SettingsView {
  baseUrl: string
  apiKeySet: boolean
  insecure: boolean
  kanbanStatusIds: number[]
}
