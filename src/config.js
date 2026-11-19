/**
 * Settings storage for model rotation.
 *
 * Kept as a plain JSON document under the Harness home rather than in the Cordis
 * config layer: chains are edited far more often than a composition, every edit
 * must reach a running adapter without a restart, and a broken patch file must
 * not take the model menu down with it.
 *
 * @module config
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeRoute } from './chain.js'

/** Directory under the Harness home holding this plugin's data. */
export const DATA_DIR = 'model-rotation'
export const SETTINGS_FILE = 'settings.json'

/** The virtual provider route this plugin owns. */
export const ROUTER_PROVIDER = 'model-rotation'

/** Most chains a settings document may define. */
export const MAX_CHAINS = 16

/** Most routes one chain may hold. */
export const MAX_ROUTES = 16

/**
 * Resolve the Harness home the way DSH does.
 * @returns {string} absolute Harness home.
 */
export function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * Coerce one stored chain.
 * @param {unknown} raw - a stored chain.
 * @param {number} index - its position, used to derive a fallback id.
 * @returns {{id: string, name: string, enabled: boolean, routes: Array<object>} | undefined}
 */
export function normalizeChain(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : ''
  const id = (rawId || 'chain-' + (index + 1)).replace(/[^A-Za-z0-9_-]/g, '-')
  if (id === ROUTER_PROVIDER) return undefined
  const routes = []
  const seen = new Set()
  for (const entry of Array.isArray(raw.routes) ? raw.routes : []) {
    const route = normalizeRoute(entry)
    if (!route || route.provider === ROUTER_PROVIDER) continue
    const key = route.provider + '\u0000' + route.model
    if (seen.has(key)) continue
    seen.add(key)
    routes.push(route)
    if (routes.length >= MAX_ROUTES) break
  }
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id
  return { id, name, enabled: raw.enabled !== false, routes }
}

/**
 * Coerce a whole stored document.
 * @param {unknown} raw - parsed settings, possibly missing or corrupt.
 * @returns {{version: number, chains: Array<object>}} usable settings.
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const chains = []
  const seen = new Set()
  for (const [index, row] of (Array.isArray(source.chains) ? source.chains : []).entries()) {
    const chain = normalizeChain(row, index)
    if (!chain || seen.has(chain.id)) continue
    seen.add(chain.id)
    chains.push(chain)
    if (chains.length >= MAX_CHAINS) break
  }
  return { version: 1, chains }
}

/**
 * JSON store with mtime-based invalidation.
 *
 * Two writers exist (this plugin's own API and a hand edit), so a cached copy
 * cannot be trusted: every read compares mtime and size against the snapshot
 * that produced it.
 */
export class SettingsStore {
  #file
  #cache
  #log
  #listeners = new Set()

  /**
   * @param {string} [file] - absolute settings path; defaults under the Harness home.
   * @param {{log?: (message: string) => void}} [options] - diagnostics sink.
   */
  constructor(file = join(resolveHome(), DATA_DIR, SETTINGS_FILE), options = {}) {
    this.#file = file
    this.#log = options.log ?? (() => {})
    this.#cache = { settings: normalizeSettings(undefined), mtimeMs: -1, size: -1 }
  }

  /** @returns {string} absolute settings path. */
  get file() {
    return this.#file
  }

  /**
   * Subscribe to observed changes.
   * @param {() => void} listener - called after a changed document is cached.
   * @returns {() => void} unsubscriber.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #notify() {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        this.#log(`model-rotation: settings listener failed (${String(error)})`)
      }
    }
  }

  /**
   * Read current settings, reusing the cache while the file is unchanged.
   * @returns {{settings: object, error?: string}} settings plus any read diagnostic.
   */
  read() {
    let stat
    try {
      stat = statSync(this.#file)
    } catch {
      this.#cache = { settings: normalizeSettings(undefined), mtimeMs: -1, size: -1 }
      return { settings: this.#cache.settings }
    }
    if (stat.mtimeMs === this.#cache.mtimeMs && stat.size === this.#cache.size) {
      return {
        settings: this.#cache.settings,
        ...(this.#cache.error === undefined ? {} : { error: this.#cache.error }),
      }
    }
    let raw
    let error
    try {
      raw = JSON.parse(readFileSync(this.#file, 'utf8'))
    } catch (cause) {
      error = `settings file is unreadable; using defaults (${String(cause)})`
      this.#log(`model-rotation: ${error}`)
    }
    const settings = normalizeSettings(raw)
    this.#cache = { settings, mtimeMs: stat.mtimeMs, size: stat.size, ...(error === undefined ? {} : { error }) }
    this.#notify()
    return { settings, ...(error === undefined ? {} : { error }) }
  }

  /**
   * Replace the whole document atomically.
   * @param {unknown} next - proposed settings.
   * @returns {{settings: object}} the stored value.
   */
  write(next) {
    const settings = normalizeSettings(next)
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.#file)
    } catch (cause) {
      try {
        unlinkSync(temporary)
      } catch {
        // The temporary may already be gone; the original failure is the one to report.
      }
      throw cause
    }
    const stat = statSync(this.#file)
    this.#cache = { settings, mtimeMs: stat.mtimeMs, size: stat.size }
    this.#notify()
    return { settings }
  }
}
