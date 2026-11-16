import test from 'node:test'
import assert from 'node:assert/strict'
import { KEY, readEnabled, writeEnabled } from '../web/enabled-preference.js'

function storage(initial) {
  const values = new Map(initial === undefined ? [] : [[KEY, initial]])
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    value: () => values.get(KEY),
  }
}

test('defaults to disabled when no explicit opt-in was stored', () => {
  assert.equal(readEnabled(storage()), false)
  assert.equal(readEnabled(null), false)
})

test('persists explicit enable and disable across page reloads', () => {
  const store = storage()
  writeEnabled(store, true)
  assert.equal(store.value(), '1')
  assert.equal(readEnabled(store), true)
  writeEnabled(store, false)
  assert.equal(store.value(), '0')
  assert.equal(readEnabled(store), false)
})

test('cookie fallback survives a Desktop restart on a different loopback port', () => {
  const fakeDocument = { cookie: 'dsh_input_predict_enabled=1; other=value' }
  Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true })
  try {
    assert.equal(readEnabled({ getItem: () => null }), true)
    writeEnabled({ getItem: () => null, setItem: () => {} }, false)
    assert.match(fakeDocument.cookie, /dsh_input_predict_enabled=0/)
    assert.equal(readEnabled(null), false)
  } finally {
    delete globalThis.document
  }
})

test('unavailable or throwing storage fails closed without breaking the composer', () => {
  const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(readEnabled(throwing), false)
  assert.doesNotThrow(() => writeEnabled(throwing, true))
  assert.equal(readEnabled(undefined), false)
})
