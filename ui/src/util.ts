import * as sdk from '@kirocrew/app-sdk'
import type { SavedView } from './types'

export const API = '/api/apps/redmine-board'
export const AGENT = 'redmine-board-assistant'
const VIEW_KEY = 'redmine-board:view'

export interface ViewState {
  expr: string
  tab: 'board' | 'list'
  sort: string
}

export const MY_TOKEN = 'assignee:me'

// first visit shows the issues assigned to the current user
export const DEFAULT_VIEW: ViewState = { expr: MY_TOKEN, tab: 'board', sort: 'updated_on:desc' }

const PROJECT_TOKEN = /(?:^|\s)(?:project|プロジェクト):("?)([^\s",]+)\1(?=\s|$)/g

/** The identifier in the first project: token, if any. */
export function projectOf(expr: string): string | null {
  PROJECT_TOKEN.lastIndex = 0
  return PROJECT_TOKEN.exec(expr)?.[2] ?? null
}

/** Replace every project: token with one for ident (or drop them for null). */
export function setProject(expr: string, ident: string | null): string {
  const rest = expr.replace(PROJECT_TOKEN, ' ').replace(/\s{2,}/g, ' ').trim()
  return ident ? addToken(rest, `project:${ident}`) : rest
}

/** Whether the expression contains token as a whole word. */
export function hasToken(expr: string, token: string): boolean {
  return expr.split(/\s+/).includes(token)
}

/** Split an expression into raw tokens, keeping "quoted values" together. */
export function splitTokens(expr: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (const ch of expr) {
    if (ch === '"') {
      inQ = !inQ
      cur += ch
    } else if (/\s/.test(ch) && !inQ) {
      if (cur) out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

const FIELD_TOKEN = /^-?[^\s:"]+:/

/** The free-text (keyword) part of an expression. */
export function keywordOf(expr: string): string {
  return splitTokens(expr).filter((t) => !FIELD_TOKEN.test(t)).join(' ')
}

/** Replace the free-text part, keeping every field token. */
export function setKeyword(expr: string, text: string): string {
  const fields = splitTokens(expr).filter((t) => FIELD_TOKEN.test(t))
  return [...fields, ...splitTokens(text)].join(' ')
}

/** Value of the first non-negated field:value token (canonical key only). */
export function fieldValue(expr: string, field: string): string | null {
  const t = splitTokens(expr).find((x) => x.startsWith(`${field}:`))
  return t ? t.slice(field.length + 1).replace(/^"|"$/g, '') : null
}

/** Drop every field:… and -field:… token, then add field:value (if any). */
export function setField(expr: string, field: string, value: string | null): string {
  const rest = splitTokens(expr).filter((t) => !t.startsWith(`${field}:`) && !t.startsWith(`-${field}:`))
  const e = rest.join(' ')
  return value ? addToken(e, `${field}:${qv(value)}`) : e
}

/** List tabs: each is a fixed set of tokens on top of the user's filters. */
export type ListTab = 'mine' | 'requested' | 'overdue' | 'all'
export const LIST_TABS: ListTab[] = ['mine', 'requested', 'overdue', 'all']
const TAB_TOKENS: Record<ListTab, string[]> = {
  mine: ['assignee:me'],
  requested: ['author:me', '-assignee:me'],
  overdue: ['due:overdue'],
  all: [],
}
const ALL_TAB_TOKENS = new Set(Object.values(TAB_TOKENS).flat())

export function tabOf(expr: string): ListTab {
  const t = new Set(splitTokens(expr))
  if (t.has('author:me') && t.has('-assignee:me')) return 'requested'
  if (t.has('assignee:me')) return 'mine'
  if (t.has('due:overdue')) return 'overdue'
  return 'all'
}

/** Switch tab: remove every tab token, then add the new tab's tokens. */
export function withTab(expr: string, tab: ListTab): string {
  // the tab's fields (e.g. assignee) win over the same field picked elsewhere
  const fields = TAB_TOKENS[tab].map((t) => t.replace(/^-/, '').split(':')[0])
  const clashes = (t: string) => fields.some((f) => t.startsWith(`${f}:`) || t.startsWith(`-${f}:`))
  const rest = splitTokens(expr).filter((t) => !ALL_TAB_TOKENS.has(t) && !clashes(t))
  return [...TAB_TOKENS[tab], ...rest].join(' ')
}

/**
 * Shorten project names by dropping "_"-separated parts that every listed
 * project shares, e.g. 66_02_XXX_アセット_プロジェクト_Ⅰ期改良 -> 02_Ⅰ期改良.
 * Returns the full names unchanged when fewer than two projects are listed.
 */
export function shortProjectNames(names: string[]): Map<string, string> {
  const uniq = [...new Set(names)]
  const out = new Map(uniq.map((n) => [n, n]))
  if (uniq.length < 2) return out
  const parts = uniq.map((n) => n.split('_'))
  const shared = new Set(parts[0].filter((p) => parts.every((ps) => ps.includes(p))))
  if (!shared.size) return out
  uniq.forEach((n, i) => {
    const kept = parts[i].filter((p) => !shared.has(p)).join('_')
    if (kept) out.set(n, kept)
  })
  return out
}

/** Add token if absent, remove every whole-word occurrence if present. */
export function toggleToken(expr: string, token: string): string {
  if (!hasToken(expr, token)) return addToken(expr, token)
  return expr.split(/\s+/).filter((t) => t && t !== token).join(' ')
}

export function loadViewState(): ViewState {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (raw) return { ...DEFAULT_VIEW, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return DEFAULT_VIEW
}

export function saveViewState(v: ViewState) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

/** Quote a value if it contains a space. */
export function qv(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v
}

/** Append a token to an expression. */
export function addToken(expr: string, token: string): string {
  const e = expr.trim()
  return e ? `${e} ${token}` : token
}

/** Remove the first exact-token occurrence from an expression. */
export function removeToken(expr: string, raw: string): string {
  const i = expr.indexOf(raw)
  if (i < 0) return expr
  return (expr.slice(0, i) + expr.slice(i + raw.length)).replace(/\s{2,}/g, ' ').trim()
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

type Fmt = { fmtDateTime?: (v: string, o?: unknown) => string; fmtDate?: (v: string, o?: unknown) => string }
const fmt = sdk as unknown as Fmt

export function fmtWhen(v: string | null | undefined): string {
  if (!v) return '—'
  return fmt.fmtDateTime?.(v) ?? new Date(v).toLocaleString()
}

export function fmtDay(v: string | null | undefined): string {
  if (!v) return '—'
  return fmt.fmtDate?.(v) ?? new Date(v).toLocaleDateString()
}

export function errCode(e: unknown): string | null {
  const body = (e as { body?: string })?.body
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      if (typeof parsed?.code === 'string') return parsed.code
    } catch {
      /* ignore */
    }
  }
  return null
}

/** Localized message for a backend error: code -> dictionary -> server text. */
export function errMessage(e: unknown, tr: (code: string) => string | null, fallback: string): string {
  const code = errCode(e)
  if (code) {
    const t = tr(code)
    if (t) return t
  }
  if (e && typeof e === 'object') {
    const anyE = e as { body?: string; message?: string }
    if (typeof anyE.body === 'string' && anyE.body) {
      try {
        const parsed = JSON.parse(anyE.body)
        if (typeof parsed?.error === 'string') return parsed.error
      } catch {
        /* fall through */
      }
      return anyE.body
    }
    if (typeof anyE.message === 'string' && anyE.message) return anyE.message
  }
  return fallback
}

/** Only http(s) links leave the app (SPEC §7 XSS). */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}

export const box = {
  card: {
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 8,
  } as React.CSSProperties,
  muted: { color: 'var(--muted)' } as React.CSSProperties,
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: 12,
    border: '1px solid var(--border)',
    background: 'var(--bg-hover, var(--card))',
    fontSize: 12,
    cursor: 'pointer',
  } as React.CSSProperties,
}

export function priorityTone(name: string | undefined): 'err' | 'warn' | 'muted' {
  const n = (name ?? '').toLowerCase()
  if (/(immediate|urgent|至急|今すぐ|緊急)/.test(n)) return 'err'
  if (/(high|高)/.test(n)) return 'warn'
  return 'muted'
}

/** Token to add when a card field is clicked for filtering. */
export function fieldToken(field: string, value: string | null | undefined, negated: boolean): string | null {
  if (value == null || value === '') return null
  return `${negated ? '-' : ''}${field}:${qv(value)}`
}

export type { SavedView }
