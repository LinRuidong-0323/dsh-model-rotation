/**
 * Bounded request log for the rotation adapter.
 *
 * Written to disk so "which model actually answered" survives a restart. The
 * settings card and the Host logger both lose that fact: the card only shows the
 * newest hit per chain, and the Host's logger does not persist info lines.
 *
 * Deliberately excludes request content. A log that records messages would leak
 * prompts into a file the user may share when reporting a bug; route names,
 * failure codes and timings are enough to diagnose routing.
 *
 * @module request-log
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Most entries kept on disk. */
const MAX_ENTRIES = 200

/**
 * Append-only log of routing decisions.
 */
export class RequestLog {
  /** @type {string} */
  #file
  /** @type {Array<object>} */
  #entries = []
  /** @type {(message: string) => void} */
  #log
  #loaded = false

  /**
   * @param {{file: string, log?: (message: string) => void}} options
   */
  constructor({ file, log }) {
    this.#file = file
    this.#log = log ?? (() => {})
  }

  /** @returns {string} absolute path of the log file. */
  get file() {
    return this.#file
  }

  /** Load once; a corrupt file is discarded rather than fatal. */
  #ensure() {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
      if (Array.isArray(parsed)) this.#entries = parsed.slice(-MAX_ENTRIES)
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  /**
   * Record one routing decision.
   *
   * @param {object} entry - the facts worth keeping.
   * @param {string} entry.chainId - which chain was selected.
   * @param {string} entry.provider - the route that answered.
   * @param {string} entry.model - the model that answered.
   * @param {number} entry.elapsedMs - how long it took.
   * @param {Array<object>} [entry.tried] - routes attempted before it, with codes.
   * @param {string} [entry.outcome] - `answered` or `failed`.
   * @param {string} [entry.code] - the terminal failure code, when it failed.
   */
  record(entry) {
    this.#ensure()
    this.#entries.push({
      at: new Date().toISOString(),
      chainId: entry.chainId,
      provider: entry.provider,
      model: entry.model,
      elapsedMs: entry.elapsedMs,
      outcome: entry.outcome ?? 'answered',
      ...(entry.code === undefined ? {} : { code: entry.code }),
      ...(entry.tried === undefined || entry.tried.length === 0
        ? {}
        : {
            tried: entry.tried.map(item => ({
              provider: item.route?.provider,
              model: item.route?.model,
              code: item.code,
            })),
          }),
    })
    if (this.#entries.length > MAX_ENTRIES) {
      this.#entries = this.#entries.slice(-MAX_ENTRIES)
    }
    this.#flush()
  }

  /** Write the whole file atomically. */
  #flush() {
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporary, `${JSON.stringify(this.#entries, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.#file)
    } catch (error) {
      // A failed log write must never break routing.
      try {
        unlinkSync(`${this.#file}.${process.pid}.${Date.now()}.tmp`)
      } catch {
        // Nothing to clean up.
      }
      this.#log(`model-rotation: request log write failed (${String(error)})`)
    }
  }

  /**
   * Read the newest entries.
   * @param {{limit?: number}} [options]
   * @returns {Array<object>} entries, newest last.
   */
  read(options = {}) {
    this.#ensure()
    const limit = Math.max(1, Math.min(MAX_ENTRIES, options.limit ?? 50))
    return this.#entries.slice(-limit)
  }

  /** @returns {number} how many entries are held. */
  get size() {
    this.#ensure()
    return this.#entries.length
  }
}
