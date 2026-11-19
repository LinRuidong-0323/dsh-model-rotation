/**
 * dsh-model-rotation — Host half.
 *
 * Registers one provider route (`model-rotation`) whose models are the user's
 * named chains, and serves the settings API the browser card talks to.
 *
 * The exported `Config` schema is what makes this plugin appear in
 * 设置 → 内置插件: the settings mirror enumerates `configEditor.configuration()`
 * and **skips any entry without a schema**. Without it the card cannot render no
 * matter what the client registers.
 *
 * @module dsh-model-rotation
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { RotationAdapter } from './src/adapter.js'
import { API_PREFIX, createHandler } from './src/http.js'
import { ROUTER_PROVIDER, SettingsStore } from './src/config.js'
import { CooldownTable } from './src/cooldown.js'
import { RequestLog } from './src/request-log.js'

export const name = 'model-rotation'

/** `llm` is required; the web surface is optional. */
export const inject = ['llm']

/**
 * Build the configuration schema from a schemastery factory.
 *
 * Every field must carry `volatile`, because the settings mirror only renders
 * fields whose nearest volatile ancestor allows editing without remounting:
 * `volatileForm()` returns undefined for a schema with no volatile field, and
 * `describe()` then skips the whole entry — the plugin gets no settings
 * namespace and its card cannot appear.
 *
 * @param {Function} Schema - the default export of `@deepseek-ai/schemastery`.
 * @returns {object} a schema object the settings mirror can describe.
 */
function buildConfig(Schema) {
  return Schema.object({
    /** How long a failed route is held out of the front of the chain. */
    cooldownSeconds: Schema.number()
      .default(15)
      .min(0)
      .max(600)
      .description('失败路由的基础冷却秒数（连续失败指数增长，上限 10 分钟）')
      .extra('volatile', true),
    /** How long a route attempt may go without progress before it is abandoned. */
    idleTimeoutSeconds: Schema.number()
      .default(90)
      .min(0)
      .max(600)
      .description('单次尝试无进展多久后放弃（0 表示不限制）')
      .extra('volatile', true),
  })
}

/**
 * Resolve schemastery synchronously, at module load.
 *
 * This must be synchronous: the loader reads a plugin's `Config` export **before**
 * it calls `apply()`, so a schema assigned inside `apply` arrives too late and
 * the settings mirror skips the entry entirely.
 *
 * `@deepseek-ai/schemastery` exports the factory as its **default** — DSH's own
 * packages import it as `import z from "@deepseek-ai/schemastery"`.
 *
 * @returns {object | undefined} the Schema factory, when reachable.
 */
function resolveSchemaSync() {
  /** Accept a default export, a named `Schema`, or the factory itself. */
  const pick = module => {
    if (module === null || module === undefined) return undefined
    const candidate = module.default ?? module.Schema ?? module
    if (typeof candidate === 'function' && typeof candidate.object === 'function') return candidate
    if (typeof candidate?.object === 'function') return candidate
    return undefined
  }

  // `createRequire` against this module resolves the plugin's own
  // `node_modules`, which is where a profile installs peer dependencies.
  try {
    const require = createRequire(import.meta.url)
    for (const specifier of ['@deepseek-ai/schemastery', 'schemastery']) {
      try {
        const found = pick(require(specifier))
        if (found !== undefined) return found
      } catch {
        // Not resolvable here.
      }
    }
  } catch {
    // No module access.
  }
  return undefined
}

const SCHEMA = resolveSchemaSync()

/**
 * Plugin configuration schema.
 *
 * The settings mirror enumerates `configEditor.configuration()` and **skips any
 * entry without a schema**, so exporting this is what makes the plugin a
 * first-class settings entry. It must be a value at module-evaluation time, not
 * something assigned later.
 *
 * @type {object | undefined}
 */
export const Config = SCHEMA === undefined ? undefined : buildConfig(SCHEMA)

/**
 * Resolve the Schema factory from the running Host.
 *
 * `@deepseek-ai/schemastery` exports the factory as its **default**, not as a
 * named `Schema` export — DSH's own packages import it as
 * `import z from "@deepseek-ai/schemastery"`.
 *
 * A junction-installed plugin cannot resolve that bare specifier, and the Host's
 * packages live inside `app.asar`, which plain Node cannot read. The only
 * reliable route is therefore the one the Host already uses internally: ask the
 * cordis loader for the module it has already imported.
 *
 * @param {object} ctx - the plugin context.
 * @returns {Promise<object | undefined>} the Schema factory, when reachable.
 */
async function resolveSchema(ctx) {
  /** Accept a default export, a named `Schema`, or the factory itself. */
  const pick = module => {
    if (module === null || module === undefined) return undefined
    const candidate = module.default ?? module.Schema ?? module
    if (typeof candidate === 'function' && typeof candidate.object === 'function') return candidate
    if (typeof candidate?.object === 'function') return candidate
    return undefined
  }

  // 1. A mounted service or registry entry, if the Host exposes one.
  for (const name of ['schemastery', '@deepseek-ai/schemastery', 'schema']) {
    try {
      const found = pick(ctx.get?.(name))
      if (found !== undefined) return found
    } catch {
      // Not a mounted service.
    }
  }

  // 2. A package the Host installed next to this plugin. A profile that adds the
  //    plugin as a normal dependency also gets schemastery resolved from the
  //    profile's own node_modules, which is where `pnpm` puts peer dependencies.
  for (const specifier of ['@deepseek-ai/schemastery', 'schemastery']) {
    try {
      const found = pick(await import(specifier))
      if (found !== undefined) return found
    } catch {
      // Try the next spelling.
    }
  }

  // 3. The Host's own installation, resolved from the module that is running this
  //    plugin. `import.meta.url` points inside the profile, and the profile's
  //    node_modules is a sibling of `profiles/`, so walking up finds the Host's
  //    packages when they were installed flat.
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const here = import.meta.url
    for (const base of [here, pathToFileURL(process.argv[1] ?? '').href]) {
      try {
        const hostRequire = createRequire(base)
        for (const specifier of ['@deepseek-ai/schemastery', 'schemastery']) {
          try {
            const found = pick(hostRequire(specifier))
            if (found !== undefined) return found
          } catch {
            // Not resolvable from this base.
          }
        }
      } catch {
        // Unusable base.
      }
    }
  } catch {
    // No module access.
  }

  return undefined
}

/**
 * Mount the rotation adapter.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - the validated plugin configuration.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? {}
  const store = new SettingsStore(undefined, { log: message => logger.warn?.(message) })

  // The settings page only lists plugins whose entry has a Config schema, so a
  // missing one is the first thing to check when the card does not appear.
  console.error('[model-rotation] apply() Config=' + (Config === undefined ? 'undefined' : 'present'))

  // Diagnostics for the settings card.
  //
  // `lastHit` / `lastFailure` are deliberately "most recent" rather than a
  // history: the card answers "what is this chain doing right now", and keeping
  // every request would grow without bound. `inFlight` is tracked separately so
  // a user can still tell that several requests are running concurrently even
  // though only the newest hit is shown.
  const lastFailure = new Map()
  const lastHit = new Map()
  let inFlight = 0

  // One cooldown table per plugin instance, so a reload starts clean.
  const cooldown = new CooldownTable(
    config.cooldownSeconds === undefined
      ? {}
      : { baseMs: config.cooldownSeconds * 1000 },
  )

  // Durable "which model actually answered" record. The settings card keeps only
  // the newest hit per chain and the Host logger does not persist info lines, so
  // a routing decision would otherwise be unrecoverable after a restart.
  // It sits next to the settings file so one directory holds all plugin state.
  const requestLog = new RequestLog({
    file: join(dirname(store.file), 'request-log.json'),
    log: message => logger.warn?.(message),
  })

  const adapter = new RotationAdapter({
    store,
    logger,
    cooldown,
    requestLog,
    hooks: {
      onAttemptStart: () => {
        inFlight += 1
      },
      onAttemptEnd: () => {
        inFlight = Math.max(0, inFlight - 1)
      },
      onSwitch: event => {
        if (event?.to !== undefined) lastHit.set(event.chainId, { ...event.to, at: Date.now() })
      },
      onFailure: event => {
        lastFailure.set(event.chainId, { code: event.code, summary: event.summary, at: Date.now() })
      },
    },
  })
  // Adopting the live `llm` service is what lets resolveModel reach the sibling
  // routes this adapter dispatches to.
  adapter.ctx = ctx

  const registration = ctx.llm.registerAdapter([ROUTER_PROVIDER], adapter)
  ctx.effect(() => () => registration(), 'model-rotation: adapter route')

  // `registerConfigurableProviders` advertises a settings entry for the route.
  // It is optional, and a kernel line that has it rejects malformed entries, so
  // a shape difference must not take routing down with it.
  try {
    const registered = ctx.llm.registerConfigurableProviders?.([
      {
        provider: ROUTER_PROVIDER,
        displayName: '模型轮换',
        settingsNs: name,
        settingsPath: [],
      },
    ])
    logger.info?.(
      'model-rotation: registerConfigurableProviders returned ' +
        (registered === undefined ? 'undefined' : typeof registered),
    )
    console.error(
      '[model-rotation] registerConfigurableProviders returned ' +
        (registered === undefined ? 'undefined' : typeof registered),
    )
  } catch (error) {
    logger.warn?.(`model-rotation: configurable-provider registration skipped (${String(error)})`)
  }

  // The picker only re-reads its catalog when the registry announces a change.
  let lastSignature
  const announce = () => {
    const { settings } = store.read()
    const signature = JSON.stringify(
      settings.chains.map(chain => [
        chain.id,
        chain.name,
        chain.enabled,
        chain.routes.map(route => route.provider + '/' + route.model),
      ]),
    )
    if (signature === lastSignature) return
    lastSignature = signature
    try {
      ctx.llm.emitAdaptersUpdated?.()
    } catch {
      // A failed notification only delays the menu refresh.
    }
  }
  ctx.effect(() => store.subscribe(announce), 'model-rotation: catalog notifications')
  ctx.effect(() => {
    const timer = setInterval(() => store.read(), 3_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'model-rotation: settings watch')

  // The settings card is served over HTTP; a profile without a web server still
  // routes model calls.
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    const handler = createHandler({
      store,
      adapter,
      logger,
      catalog: () => liveCatalog(ctx),
      diagnostics: () => ({
        lastFailure: Object.fromEntries(lastFailure),
        lastHit: Object.fromEntries(lastHit),
        inFlight,
        coolingCount: cooldown.size,
        // Newest last. Bounded by RequestLog itself, so this cannot grow with
        // the session; the card shows only a few rows.
        recentRequests: requestLog.read({ limit: 20 }),
        requestLogFile: requestLog.file,
      }),
    })
    scoped.effect(() => server.register({ kind: 'prefix', path: API_PREFIX, handler }), 'model-rotation: api routes')
    logger.info?.(`model-rotation: settings API mounted at ${API_PREFIX}`)
  })
}

/**
 * The provider-grouped catalog the settings card offers.
 *
 * Excludes this plugin's own route: a chain whose editor offered chains as
 * routes would let a user build a cycle through the UI.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {Promise<Array<object>>} groups for the editor.
 */
async function liveCatalog(ctx) {
  const llm = ctx.llm
  if (llm === undefined) return []
  const providers = llm.listProviders().filter(provider => provider.id !== ROUTER_PROVIDER)
  return Promise.all(
    providers.map(async provider => {
      try {
        const models = await llm.listModels(provider.id)
        return {
          id: provider.id,
          name: provider.name,
          models: models.map(model => ({ id: model.id, name: model.name })),
        }
      } catch (error) {
        // A provider that cannot answer is reported as an empty group so the
        // card can still show the route and its diagnostic.
        return { id: provider.id, name: provider.name, models: [], error: String(error) }
      }
    }),
  ).then(groups => groups.filter(group => group.models.length > 0 || group.error !== undefined))
}

export { ROUTER_PROVIDER }
