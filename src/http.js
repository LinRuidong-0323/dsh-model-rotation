/**
 * Settings surface over HTTP, consumed by this plugin's browser card.
 *
 * A prefix route longer than `/api` outranks the kernel's own dispatch, so this
 * handler re-applies the same trust decision the kernel would have applied: a
 * loopback host, no cross-site fetch, and a matching Origin.
 *
 * @module http
 */

/** Fixed marker every route sits under. */
export const API_PREFIX = '/api/model-rotation'

/** Largest settings body accepted, in bytes. */
const MAX_BODY_BYTES = 256 * 1024

/** Hostnames a same-machine browser can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** An error carrying the status code to answer with. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Split an authority value into scheme, hostname and port. */
function authority(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
}

/**
 * Decide whether a request may use these routes.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {number | undefined} status to reject with, or undefined to allow.
 */
export function rejectionFor(req) {
  const host = authority(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const origin = authority(raw.trim())
    if (origin === null) return 403
    if (origin.hostname !== host.hostname || origin.port !== host.port) return 403
  }
  return undefined
}

/** Read a JSON body, bounded. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, '请求体过大'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        const value = JSON.parse(raw)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          reject(new HttpError(400, '请求体必须是 JSON 对象'))
          return
        }
        resolve(value)
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Write a JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Strip the API prefix from a pathname. */
function stripPrefix(pathname) {
  if (pathname === API_PREFIX) return '/'
  if (!pathname.startsWith(`${API_PREFIX}/`)) return ''
  return pathname.slice(API_PREFIX.length)
}

/**
 * Build the route handler.
 * @param {object} deps - wiring supplied by the plugin entry.
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createHandler(deps) {
  const { store, catalog, diagnostics, logger } = deps

  return async function handler(req, res) {
    const rejection = rejectionFor(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { error: rejection === 401 ? '未登录' : '来源不受信任' })
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = stripPrefix(url.pathname)
    const method = String(req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && routePath === '/state') {
        const { settings, error } = store.read()
        let groups = []
        try {
          groups = await catalog()
        } catch (cause) {
          logger?.warn?.(`model-rotation: catalog read failed: ${String(cause)}`)
        }
        sendJson(res, 200, {
          settings,
          ...(error === undefined ? {} : { warning: error }),
          catalog: Array.isArray(groups) ? groups : [],
          diagnostics: diagnostics?.() ?? {},
          file: store.file,
        })
        return
      }

      if (method === 'POST' && routePath === '/save') {
        const body = await readJson(req)
        const { settings } = store.write(body)
        sendJson(res, 200, { settings })
        return
      }

      sendJson(res, 404, { error: '未知路由' })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status >= 500) logger?.warn?.(`model-rotation: settings request failed: ${String(error)}`)
      sendJson(res, status, { error: status >= 500 ? '设置操作失败' : error.message })
    }
  }
}
