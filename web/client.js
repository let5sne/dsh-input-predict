import React from 'react'
import { PredictionController } from './prediction-controller.js'
import { createInputBridge } from './input-bridge.js'
import { browserStorage } from './enabled-preference.js'
import { createPredictionStore } from './prediction-store.js'

const h = React.createElement
const NS = 'input-predict'
const BUILD = '20261116-placeholder3'
/** Toolbar row, left of the model selector. */
const ICON_SLOT = 'conversation.input.right'
/** Positioned inside the composer card, over the editor's text column. */
const HINT_SLOT = 'conversation.input.overlay'

/**
 * The hint copies the native placeholder's geometry (InputBar.module.css
 * `.placeholder`: inset 4px 8px auto 14px, caption color) so the prediction
 * reads as the placeholder itself. The overlay anchor is a zero-height box at
 * the card's top; the editor's text column begins 8px below it.
 */
const CSS = `
.dsh-ip-icon{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;cursor:pointer;flex:none;color:var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));transition:background-color .12s ease,color .12s ease}
.dsh-ip-icon[aria-checked="true"]{color:var(--dsw-alias-label-primary)}
.dsh-ip-icon:hover:not(:disabled){background:color-mix(in srgb,currentColor 12%,transparent)}
.dsh-ip-icon:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-ip-icon:disabled{opacity:.4;cursor:default}
.dsh-ip-hint{position:absolute;top:12px;left:14px;right:12px;display:flex;align-items:center;gap:6px;pointer-events:none;user-select:none;font-family:var(--dsw-font-family);font-size:var(--dsh-content-font-size, 14px);line-height:calc(24px + var(--dsh-content-font-delta, 0px));color:var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary))}
.dsh-ip-hint-icon{flex:none;display:flex;color:var(--dsw-alias-label-secondary)}
.dsh-ip-hint-text{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ip-hint-key{flex:none;margin-left:2px;font-size:12px;line-height:18px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
@media (pointer: coarse){.dsh-ip-hint{font-size:max(16px, var(--dsh-content-font-size, 14px))}}
`

const messages = {
  en: {
    enable: 'Turn on input prediction. Recent conversation text is sent to the configured model; additional usage charges may apply.',
    disable: 'Turn off input prediction',
    unavailable: 'Input prediction is disabled or unavailable on this Host',
    acceptKey: 'Tab',
    hintLabel: 'Predicted next message. Press Tab to use it.',
  },
  zh: {
    enable: '开启输入预测：近期会话文本会发送给配置的模型，并可能产生额外费用。',
    disable: '关闭输入预测',
    unavailable: 'Host 未启用输入预测或服务不可用',
    acceptKey: 'Tab',
    hintLabel: '预测的下一条消息，按 Tab 采纳。',
  },
}

/**
 * Original geometry: a text cursor followed by a dotted predicted continuation.
 * The toolbar toggle and the in-editor hint draw the same glyph, so the hint
 * reads as coming from that toggle.
 */
function PredictIcon({ size = 18 }) {
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    focusable: false, style: { display: 'block' },
  },
  h('path', { d: 'M5 5v14' }),
  h('path', { d: 'M3 5h4M3 19h4' }),
  h('path', { d: 'M10.5 12h.01M14.5 12h.01M18.5 12h.01', strokeWidth: 2.6 }),
  h('path', { d: 'm17 8.5 3.5 3.5-3.5 3.5' }))
}

export const inject = ['slots', 'locale', 'connection', 'remote', 'shortcuts']

export function apply(ctx) {
  const store = createPredictionStore(browserStorage())
  const controllers = new Set()
  const lifetime = new AbortController()
  const history = new Map()
  const remote = { config: 0, snapshot: 0, predict: 0, failures: 0, recent: [] }

  async function call(method, request, signal) {
    signal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])
    const started = Date.now()
    try {
      const result = await ctx.connection.rpc.call('/api', `inputPredict/${method}`,
        { args: request === undefined ? {} : { request } }, signal)
      const code = !result.ok ? result.error?.code : result.value?.ok === false ? result.value.error?.code : null
      if (!result.ok) throw Object.assign(new Error('prediction-remote-failed'), { code })
      if (result.value?.ok === false) throw Object.assign(new Error('prediction-rejected'), { code })
      remote[method]++
      remote.recent.push({ method, ok: true, time: started, ms: Date.now() - started })
      if (remote.recent.length > 12) remote.recent.shift()
      return result.value
    } catch (error) {
      remote.failures++
      remote.recent.push({ method, ok: false, code: error?.code || 'local-error', time: started, ms: Date.now() - started })
      if (remote.recent.length > 12) remote.recent.shift()
      throw error
    }
  }

  // Host config is shared by every composer; reload it on reconnect.
  let configAbort
  const reloadConfig = () => {
    configAbort?.abort()
    const request = configAbort = new AbortController()
    call('config', undefined, request.signal).then(config => {
      if (!request.signal.aborted) store.setSettings(config)
    }, () => { if (!request.signal.aborted) store.setSettings({ enabled: false }) })
  }
  ctx.effect(() => {
    reloadConfig()
    const off = ctx.connection.generation.subscribe(reloadConfig)
    return () => { configAbort?.abort(); off() }
  }, 'input-predict: host config')

  const useStore = () => React.useSyncExternalStore(store.subscribe, store.getSnapshot)

  /** Toolbar toggle: grey when off, dark when on. */
  function PredictToggle(props) {
    const { enabled, hostEnabled, settings } = useStore()
    const t = props.t
    const unavailable = settings !== null && !hostEnabled
    const label = unavailable ? t('unavailable') : enabled ? t('disable') : t('enable')
    return h(React.Fragment, null,
      h('style', null, CSS),
      h('button', {
        type: 'button', className: 'dsh-ip-icon', role: 'switch', 'aria-checked': enabled,
        'aria-label': label, title: label, disabled: unavailable,
        // Keep the caret in the editor: the editor's focus starts the first request.
        onMouseDown: event => event.preventDefault(),
        onClick: () => store.toggle(),
      }, h(PredictIcon)))
  }

  /** Suggestion rendered as the editor's placeholder; never part of the draft. */
  function PredictHint(props) {
    const draft = props.useInput(state => state.draft)
    const draftRev = props.useInput(state => state.draftRev)
    const phase = props.useInput(state => state.phase)
    // Attachment previews render above the text column, where the hint would sit.
    const hasAttachments = props.useInput(state => state.attachmentIds.length > 0)
    // A cold or still-loading history does not make the composer ineditable;
    // only absence, an active turn, or a pending submission pauses prediction.
    const sessionBlock = props.useSession(state => state.removed ? 'session-missing'
      : state.running ? 'running' : state.pendingSubmissions.length > 0 ? 'sending' : null)
    const { active, settings } = useStore()
    const [status, setStatus] = React.useState({ phase: 'idle', text: '' })
    const anchor = React.useRef(null)
    const owned = React.useRef(null)
    const values = React.useRef(null)
    values.current = {
      sessionId: props.sessionId, draft, draftRev, enabled: active,
      running: sessionBlock !== null || phase !== 'plain',
      pauseReason: sessionBlock || (phase !== 'plain' ? 'locked' : null),
    }

    React.useEffect(() => {
      if (!anchor.current) return
      let epoch = 0
      let controller
      const bridge = createInputBridge({ anchor: anchor.current, sessionId: props.sessionId,
        inputActions: props.inputActions, onChange: () => controller?.update() })
      const trace = []
      let lastDiagnostic = ''
      const read = () => {
        const connected = ctx.connection.generation.getSnapshot() !== undefined
        const snapshot = { ...values.current, ...bridge.snapshot(), epoch,
          enabled: values.current.enabled && connected }
        const diagnostic = { sessionId: props.sessionId, enabled: !!values.current.enabled, connected,
          running: snapshot.running, pauseReason: snapshot.pauseReason, eligible: snapshot.eligible,
          reason: snapshot.reason || null, detail: snapshot.detail || null,
          draftRev: snapshot.draftRev, draftChars: snapshot.draft.length }
        const key = JSON.stringify(diagnostic)
        if (key !== lastDiagnostic) {
          lastDiagnostic = key
          const row = { ...diagnostic, time: Date.now() }
          trace.push(row)
          if (trace.length > 16) trace.shift()
          const rows = history.get(props.sessionId) ?? []
          rows.push(row)
          if (rows.length > 32) rows.shift()
          history.set(props.sessionId, rows)
        }
        return snapshot
      }
      controller = new PredictionController({ read, delay: settings?.debounceMs ?? 900,
        outputChars: settings?.limits?.outputChars ?? 600,
        snapshot: (request, signal) => call('snapshot', request, signal),
        predict: (request, signal) => call('predict', request, signal),
        insert: (text, span) => props.inputActions.insertText(text, span),
        notify: setStatus,
      })
      // A new message, a finished turn, or a reconnect is a new context.
      const invalidate = sessionId => {
        if (sessionId !== undefined && sessionId !== props.sessionId) return
        epoch++
        controller.update()
      }
      const keyboard = ctx.shortcuts.observeFixedInput(input => {
        if (input.type !== 'keydown') return
        const { gesture, context } = input
        if (gesture.composing || gesture.defaultPrevented || gesture.control || gesture.alt
          || gesture.meta || gesture.shift || gesture.repeat) return
        if (controller.state.phase !== 'ready') return
        const snapshot = bridge.snapshot()
        if (!snapshot.eligible || context.target !== snapshot.editor) return
        if (gesture.code === 'Tab' && controller.accept(snapshot.span)) input.consume()
        else if (gesture.code === 'Escape') { controller.dismiss(); input.consume() }
      })
      const disposers = [keyboard,
        ctx.remote.$on('api-session/activity', sessionId => invalidate(sessionId)),
        ctx.remote.$on('api-session/status', sessionId => invalidate(sessionId)),
        ctx.connection.generation.subscribe(() => invalidate()),
      ]
      const item = { controller, bridge, diagnostics: () => ({
        sessionId: props.sessionId, phase: controller.state.phase,
        reason: controller.state.reason || null, errorCode: controller.state.code || null,
        trace: trace.map(row => ({ ...row })),
      }) }
      owned.current = item
      controllers.add(item)
      controller.update()
      return () => {
        controller.dispose(); bridge.dispose()
        for (const dispose of disposers) dispose()
        controllers.delete(item)
        if (owned.current === item) owned.current = null
      }
    }, [props.sessionId, props.inputActions, settings])

    React.useLayoutEffect(() => { owned.current?.controller.update() }, [draft, draftRev, phase, sessionBlock, active, hasAttachments])

    const visible = active && draft === '' && !hasAttachments && status.phase === 'ready' && status.text !== ''
    // While the prediction stands in for the placeholder, hide this composer's
    // native placeholder only; the rule leaves with the hint.
    const scope = `[data-conversation-session="${String(props.sessionId).replace(/["\\]/g, '\\$&')}"]`
    // The anchor stays mounted so the bridge keeps observing; it is empty
    // and layout-free whenever no suggestion is shown.
    return h('div', { ref: anchor, 'data-input-predict-hint': '', 'data-input-predict': props.sessionId },
      visible ? h(React.Fragment, null,
        h('style', null, `${CSS}\n${scope} [data-composer-placeholder]{visibility:hidden}`),
        h('div', { className: 'dsh-ip-hint', 'aria-hidden': true },
          h('span', { className: 'dsh-ip-hint-icon' }, h(PredictIcon, { size: 14 })),
          h('span', { className: 'dsh-ip-hint-text' }, status.text),
          h('span', { className: 'dsh-ip-hint-key' }, props.t('acceptKey'))),
        // Screen readers get the suggestion once, not the decorative copy.
        h('span', { role: 'status', style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' } },
          `${props.t('hintLabel')} ${status.text}`)) : null)
  }

  ctx.inject(['cordisInspect'], inspectContext => {
    inspectContext.effect(() => inspectContext.cordisInspect.register({
      manifest: { id: 'InputPredict', description: 'Read-only input prediction gate diagnostics; no draft or candidate text.',
        methods: [{ name: 'status', description: 'Read loaded build and recent gate states for mounted composers.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: { description: 'Build identity and bounded composer metadata only.' } }] },
      async query(method) {
        if (method !== 'status') throw new Error('Unknown diagnostic method')
        const { enabled, hostEnabled, active, settings } = store.getSnapshot()
        return {
          build: BUILD,
          hostBuild: settings?.build ?? null,
          toggle: { enabled, hostEnabled, active },
          remote: { ...remote, recent: remote.recent.map(row => ({ ...row })) },
          composers: [...controllers].map(item => item.diagnostics()),
          history: [...history].map(([sessionId, rows]) => ({ sessionId, rows: rows.map(row => ({ ...row })) })),
        }
      },
    }), 'input-predict: read-only diagnostics')
  })
  ctx.effect(() => ctx.locale.register(NS, messages), 'input-predict: locale')
  // Order 10 places the icon before prompt-enhance (20), both left of the model seat.
  ctx.effect(() => ctx.slots.inject(ICON_SLOT, () => ctx.slots.register({
    name: ICON_SLOT, id: 'input-predict', order: 10, locale: NS,
  }, PredictToggle)), 'input-predict: toolbar toggle')
  ctx.effect(() => ctx.slots.inject(HINT_SLOT, () => ctx.slots.register({
    name: HINT_SLOT, id: 'input-predict-hint', order: 100, locale: NS,
  }, PredictHint)), 'input-predict: placeholder hint')
  ctx.effect(() => () => {
    lifetime.abort()
    for (const { controller, bridge } of controllers) { controller.dispose(); bridge.dispose() }
    controllers.clear()
  }, 'input-predict: cancel pending work')
}
