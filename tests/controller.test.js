import test from 'node:test'
import assert from 'node:assert/strict'
import { PredictionController } from '../web/prediction-controller.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const base = () => ({ sessionId: 's1', draft: '', draftRev: 1, epoch: 0, enabled: true, eligible: true, running: false, span: { start: 0, end: 0, draftRev: 1 } })
function fixture(overrides = {}) {
  let latest = base()
  let calls = 0
  const inserts = []
  const states = []
  const requests = []
  const controller = new PredictionController({
    delay: 1, ttl: 1000,
    read: () => latest,
    snapshot: async request => ({ ...request, contextVersion: 'v1' }),
    predict: async request => { calls++; requests.push(request); return { ...request, text: '继续下一步' } },
    insert: (text, span) => { inserts.push({ text, span }); return true },
    notify: state => states.push(state),
    ...overrides,
  })
  return {
    controller, states, inserts, requests,
    get calls() { return calls },
    update(patch = {}) { latest = { ...latest, ...patch }; controller.update() },
  }
}

test('empty draft requests a next-message prediction and shows it without writing the draft', async () => {
  const f = fixture(); f.update(); await tick()
  assert.equal(f.controller.state.phase, 'ready')
  assert.equal(f.controller.state.text, '继续下一步')
  assert.equal(f.requests[0].mode, 'next')
  assert.equal(f.requests[0].draft, '')
  assert.equal(f.inserts.length, 0)
  f.controller.dispose()
})

test('a non-empty draft hides the suggestion and never requests a prediction', async () => {
  const f = fixture(); f.update({ draft: 'hello', draftRev: 2, span: { start: 5, end: 5, draftRev: 2 } }); await tick()
  assert.equal(f.calls, 0)
  assert.notEqual(f.controller.state.phase, 'ready')
  f.controller.dispose()
})

test('typing hides the cached suggestion; clearing the draft restores it without a new request', async () => {
  const f = fixture(); f.update(); await tick()
  f.update({ draft: 'h', draftRev: 2, span: { start: 1, end: 1, draftRev: 2 } })
  assert.notEqual(f.controller.state.phase, 'ready')
  f.update({ draft: '', draftRev: 3, span: { start: 0, end: 0, draftRev: 3 } }); await tick()
  assert.equal(f.controller.state.phase, 'ready')
  assert.equal(f.controller.state.text, '继续下一步')
  assert.equal(f.calls, 1)
  f.controller.dispose()
})

test('the suggestion stays visible when the editor loses focus', async () => {
  const f = fixture(); f.update(); await tick()
  f.update({ eligible: false, reason: 'focus' })
  assert.equal(f.controller.state.phase, 'ready')
  assert.equal(f.controller.accept(), false, 'Tab acceptance still needs a focused editor')
  f.controller.dispose()
})

test('an unfocused empty editor still gets a hint; a new context refreshes it', async () => {
  const f = fixture(); f.update({ eligible: false, reason: 'focus' }); await tick()
  assert.equal(f.calls, 1)
  assert.equal(f.controller.state.phase, 'ready')
  f.update({ epoch: 1 }); await tick()
  assert.equal(f.calls, 2, 'a finished turn or new message predicts again')
  f.controller.dispose()
})

test('an unsupported or blocked input layout never requests', async () => {
  for (const reason of ['mapping', 'menu', 'composing', 'locked']) {
    const f = fixture(); f.update({ eligible: false, reason }); await tick()
    assert.equal(f.calls, 0, reason)
    f.controller.dispose()
  }
})

test('disabling hides the suggestion and cancels requests; re-enabling restores the cache', async () => {
  let signal
  let resolve
  const f = fixture({ predict: (request, s) => { signal = s; return new Promise(r => { resolve = () => r({ ...request, text: 'late' }) }) } })
  f.update(); await tick()
  f.update({ enabled: false })
  assert.equal(signal.aborted, true)
  resolve(); await tick()
  assert.notEqual(f.controller.state.phase, 'ready')
  f.controller.dispose()
  const g = fixture(); g.update(); await tick()
  g.update({ enabled: false }); assert.notEqual(g.controller.state.phase, 'ready')
  g.update({ enabled: true }); await tick()
  assert.equal(g.controller.state.phase, 'ready')
  assert.equal(g.calls, 1)
  g.controller.dispose()
})

test('running or sending pauses display; a later context change refreshes', async () => {
  const f = fixture(); f.update(); await tick()
  f.update({ running: true })
  assert.notEqual(f.controller.state.phase, 'ready')
  f.update({ running: false, epoch: 1 }); await tick()
  assert.equal(f.calls, 2)
  f.controller.dispose()
})

test('accept inserts at a fresh span once and does not resend', async () => {
  const f = fixture(); f.update(); await tick()
  const fresh = { start: 0, end: 0, draftRev: 1 }
  assert.equal(f.controller.accept(fresh), true)
  assert.deepEqual(f.inserts, [{ text: '继续下一步', span: fresh }])
  assert.equal(f.controller.accept(fresh), false)
  f.controller.dispose()
})

test('accept refuses a span from another revision or when unfocused', async () => {
  const f = fixture(); f.update(); await tick()
  assert.equal(f.controller.accept({ start: 0, end: 0, draftRev: 9 }), false)
  assert.equal(f.inserts.length, 0)
  f.controller.dispose()
})

test('failed insertion keeps the suggestion and reports false', async () => {
  const f = fixture({ insert: () => false }); f.update(); await tick()
  assert.equal(f.controller.accept({ start: 0, end: 0, draftRev: 1 }), false)
  assert.equal(f.controller.state.phase, 'ready')
  f.controller.dispose()
})

test('dismiss hides the suggestion until the context changes', async () => {
  const f = fixture(); f.update(); await tick()
  f.controller.dismiss()
  f.update({ draft: 'x', draftRev: 2 }); f.update({ draft: '', draftRev: 3 }); await tick()
  assert.notEqual(f.controller.state.phase, 'ready')
  assert.equal(f.calls, 1)
  f.update({ epoch: 1 }); await tick()
  assert.equal(f.calls, 2)
  f.controller.dispose()
})

test('late responses for an old context are discarded', async () => {
  const pending = []
  const f = fixture({ predict: request => new Promise(resolve => pending.push({ request, resolve })) })
  f.update(); await tick()
  f.update({ epoch: 1 }); await tick()
  pending[0].resolve({ ...pending[0].request, text: 'stale' }); await tick()
  assert.notEqual(f.controller.state.text, 'stale')
  pending[1].resolve({ ...pending[1].request, text: 'fresh' }); await tick()
  assert.equal(f.controller.state.text, 'fresh')
  f.controller.dispose()
})

test('identity mismatches and empty results do not show a suggestion', async () => {
  for (const reply of [request => ({ ...request, sessionId: 'other', text: 'bad' }), request => ({ ...request, text: '  ' })]) {
    const f = fixture({ predict: async request => reply(request) }); f.update(); await tick()
    assert.notEqual(f.controller.state.phase, 'ready')
    f.controller.dispose()
  }
})

test('the suggestion expires after its time to live', async () => {
  const f = fixture({ ttl: 5 }); f.update(); await tick(); await tick()
  assert.notEqual(f.controller.state.phase, 'ready')
  f.controller.dispose()
})

test('errors do not retry on every focus change; retry requests again', async () => {
  let n = 0
  const f = fixture({ predict: async () => { n++; throw Object.assign(new Error('offline'), { code: 'offline' }) } })
  f.update(); await tick()
  assert.equal(f.controller.state.phase, 'error')
  f.update({ eligible: false, reason: 'focus' }); f.update({ eligible: true, reason: null }); await tick()
  assert.equal(n, 1)
  f.controller.retry(); await tick()
  assert.equal(n, 2)
  f.controller.dispose()
})

test('disposal aborts an in-flight request and prevents publication', async () => {
  let signal
  let resolve
  const f = fixture({ predict: (request, s) => { signal = s; return new Promise(r => { resolve = () => r({ ...request, text: 'late' }) }) } })
  f.update(); await tick()
  f.controller.dispose()
  assert.equal(signal.aborted, true)
  const n = f.states.length; resolve(); await tick()
  assert.equal(f.states.length, n)
})
