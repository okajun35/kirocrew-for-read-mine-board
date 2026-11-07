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

export const DEFAULT_VIEW: ViewState = { expr: '', tab: 'board', sort: 'updated_on:desc' }

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
