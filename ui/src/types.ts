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

export interface SearchResult {
  issues: IssueSummary[]
  total: number
  offset: number
  limit: number
  direct?: number
  note?: string
}

export interface BoardResult {
  columns: { status: StatusRef; issues: IssueSummary[]; total: number }[]
  perColumn: number
  note?: string
}

export interface Meta {
  baseUrl: string
  user: { id: number; login: string; name: string; admin: boolean }
  projects: { id: number; identifier: string; name: string; parentId: number | null }[]
  statuses: StatusRef[]
  trackers: Ref[]
}

export interface SettingsView {
  baseUrl: string
  apiKeySet: boolean
  insecure: boolean
  kanbanStatusIds: number[]
}

export interface Filters {
  q: string
  project: string
  status: string
  assignee: string
}
