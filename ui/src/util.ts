import * as sdk from '@kirocrew/app-sdk'
import type { Filters } from './types'

export const API = '/api/apps/redmine-board'
export const AGENT = 'redmine-board-assistant'
const FILTERS_KEY = 'redmine-board:filters'

export const DEFAULT_FILTERS: Filters = { q: '', project: '', status: 'open', assignee: '' }

export function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY)
    if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return DEFAULT_FILTERS
}

export function saveFilters(f: Filters) {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(f))
  } catch {
    /* ignore */
  }
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

export function errMessage(e: unknown, fallback: string): string {
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
}

export function priorityTone(name: string | undefined): 'err' | 'warn' | 'muted' {
  const n = (name ?? '').toLowerCase()
  if (/(immediate|urgent|至急|今すぐ|緊急)/.test(n)) return 'err'
  if (/(high|高)/.test(n)) return 'warn'
  return 'muted'
}
