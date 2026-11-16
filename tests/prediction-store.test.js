import test from 'node:test'
import assert from 'node:assert/strict'
import { createPredictionStore } from '../web/prediction-store.js'

function storage(initial = null) {
  let value = initial
  return { getItem: () => value, setItem: (_key, next) => { value = next }, value: () => value }
}

test('starts from the persisted opt-in and notifies subscribers on toggle', () => {
  const store = createPredictionStore(storage('0'))
  let notified = 0
  const off = store.subscribe(() => { notified++ })
  assert.equal(store.getSnapshot().enabled, false)
  store.toggle()
  assert.equal(store.getSnapshot().enabled, true)
  assert.equal(notified, 1)
  off(); store.toggle()
  assert.equal(notified, 1)
})

test('toggle persists the explicit choice', () => {
  const s = storage(null)
  const store = createPredictionStore(s)
  store.toggle()
  assert.equal(s.value(), '1')
  store.toggle()
  assert.equal(s.value(), '0')
})

test('snapshots are stable between changes for useSyncExternalStore', () => {
  const store = createPredictionStore(storage('1'))
  assert.equal(store.getSnapshot(), store.getSnapshot())
  const before = store.getSnapshot()
  store.setSettings({ enabled: true, debounceMs: 900 })
  assert.notEqual(store.getSnapshot(), before)
  assert.equal(store.getSnapshot().hostEnabled, true)
})

test('prediction is active only when both the user and the Host allow it', () => {
  const store = createPredictionStore(storage('1'))
  assert.equal(store.getSnapshot().active, false, 'unknown Host settings fail closed')
  store.setSettings({ enabled: true })
  assert.equal(store.getSnapshot().active, true)
  store.setSettings({ enabled: false })
  assert.equal(store.getSnapshot().active, false)
  store.setSettings({ enabled: true }); store.toggle()
  assert.equal(store.getSnapshot().active, false)
})
