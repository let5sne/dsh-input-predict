/**
 * Framework-independent prediction lifecycle for the empty-composer hint.
 *
 * One suggestion is predicted per conversation context (session + epoch) and
 * cached. It is displayed only while prediction is enabled, the draft is
 * empty, and no turn is running; typing hides it and clearing the draft
 * shows it again without a new request. No draft write happens until accept().
 */
/** Editor states that only matter for Tab acceptance, not for showing a hint. */
const PASSIVE_REASONS = new Set(['focus', 'selection', 'span'])

export class PredictionController {
  constructor({ read, snapshot, predict, insert, notify, delay = 900, ttl = 300000, outputChars = 600 }) {
    Object.assign(this, { read, snapshot, predict, insert, notify, delay, ttl, outputChars })
    this.state = { phase: 'idle', text: '' }
    this.generation = 0
    this.disposed = false
    this.cache = null
    this.attemptedKey = null
    this.dismissedKey = null
  }

  /** Context identity: a new assistant turn or reconnect bumps epoch. */
  contextKey(value) {
    return JSON.stringify([value.sessionId, value.epoch])
  }

  /** Why the hint cannot be shown now, or null when it can. */
  blockedReason(value) {
    if (!value.enabled) return 'disabled'
    if (value.running) return value.pauseReason || 'running'
    if (typeof value.draft !== 'string' || value.draft !== '') return 'draft'
    return null
  }

  publish(state) {
    if (this.disposed) return
    const next = { text: '', ...state }
    if (this.state.phase === next.phase && this.state.text === next.text
      && this.state.reason === next.reason && this.state.code === next.code) return
    this.state = next
    this.notify(this.state)
  }

  cancelRequest() {
    this.generation++
    clearTimeout(this.timer)
    this.abort?.abort()
    this.abort = undefined
  }

  update() {
    if (this.disposed) return
    const value = this.read()
    const key = this.contextKey(value)
    if (this.cache && (this.cache.key !== key || Date.now() >= this.cache.expires)) {
      // An expired hint is not re-requested automatically; a new turn or Retry refreshes it.
      if (this.cache.key === key) this.attemptedKey = key
      this.cache = null
    }
    if (this.pending && this.pending !== key) this.cancelRequest(), this.pending = null
    const reason = this.blockedReason(value)
    if (reason === 'disabled') this.cancelRequest(), this.pending = null
    if (reason !== null) {
      this.publish({ phase: 'idle', reason })
      return
    }
    if (this.dismissedKey === key) {
      this.publish({ phase: 'idle', reason: 'dismissed' })
      return
    }
    if (this.cache) {
      this.publish({ phase: this.cache.text ? 'ready' : 'empty', text: this.cache.text })
      return
    }
    if (this.pending === key) return
    if (this.attemptedKey === key) {
      // A failed attempt is not retried on focus churn; Retry clears it.
      if (this.state.phase !== 'error') this.publish({ phase: 'idle', reason: 'already-tried' })
      return
    }
    // A placeholder needs no caret: an unfocused or unselected empty editor
    // may request. Structural blockers (unsupported layout, open menus, IME,
    // locked or hidden editor) still pause it.
    if (!value.eligible && !PASSIVE_REASONS.has(value.reason)) {
      this.publish({ phase: 'idle', reason: value.reason || 'mapping' })
      return
    }
    this.pending = key
    const generation = ++this.generation
    this.publish({ phase: 'waiting' })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.generate(value, key, generation) }, this.delay)
  }

  current(key, generation) {
    if (this.disposed || this.generation !== generation) return false
    const value = this.read()
    return this.contextKey(value) === key && value.enabled
  }

  async generate(value, key, generation) {
    if (!this.current(key, generation)) { if (this.pending === key) this.pending = null; return }
    this.attemptedKey = key
    const abort = this.abort = new AbortController()
    const identity = { sessionId: value.sessionId, requestId: globalThis.crypto.randomUUID(), draftRev: value.draftRev }
    this.publish({ phase: 'loading' })
    try {
      const snapshot = await this.snapshot(identity, abort.signal)
      if (!this.current(key, generation)) return
      if (!this.matches(snapshot, identity) || typeof snapshot.contextVersion !== 'string') throw new Error('invalid-snapshot')
      const request = { ...identity, contextVersion: snapshot.contextVersion, draft: '', mode: 'next' }
      const result = await this.predict(request, abort.signal)
      if (!this.current(key, generation)) return
      if (!this.matches(result, request) || result.contextVersion !== request.contextVersion || result.mode !== request.mode
        || typeof result.text !== 'string' || result.text.length > this.outputChars) throw new Error('invalid-response')
      this.cache = { key, text: result.text.trim() === '' ? '' : result.text, expires: Date.now() + this.ttl }
      this.pending = null
      clearTimeout(this.expiryTimer)
      this.expiryTimer = setTimeout(() => { this.update() }, this.ttl)
      this.update()
    } catch (error) {
      if (this.current(key, generation) && !abort.signal.aborted) {
        this.pending = null
        this.publish({ phase: 'error', code: error?.code || 'prediction-failed' })
      }
    } finally {
      if (this.abort === abort) this.abort = undefined
      if (this.pending === key && !this.current(key, generation)) this.pending = null
    }
  }

  matches(result, request) {
    return result?.sessionId === request.sessionId && result?.requestId === request.requestId
      && result?.draftRev === request.draftRev
  }

  /**
   * Insert the visible suggestion as real draft text.
   * @param freshSpan - span captured from the focused, empty editor at the keypress.
   * @returns whether the platform inserted it; callers consume Tab only on true.
   */
  accept(freshSpan) {
    if (this.state.phase !== 'ready' || !this.cache?.text || freshSpan === undefined) return false
    const value = this.read()
    if (this.blockedReason(value) !== null || !value.eligible
      || freshSpan.start !== freshSpan.end || freshSpan.draftRev !== value.draftRev) return false
    let inserted = false
    try { inserted = this.insert(this.cache.text, freshSpan) === true } catch { inserted = false }
    if (inserted) {
      // Accepted text belongs to the draft now; never offer it again here.
      this.dismissedKey = this.cache.key
      this.publish({ phase: 'idle', reason: 'draft' })
    }
    return inserted
  }

  dismiss() {
    if (this.cache) this.dismissedKey = this.cache.key
    this.publish({ phase: 'idle', reason: 'dismissed' })
  }

  retry() {
    this.cancelRequest()
    this.pending = null
    this.cache = null
    this.attemptedKey = null
    this.dismissedKey = null
    this.update()
  }

  dispose() {
    this.cancelRequest()
    clearTimeout(this.expiryTimer)
    this.disposed = true
    this.cache = null
  }
}
