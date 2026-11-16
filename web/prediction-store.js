import { readEnabled, writeEnabled } from './enabled-preference.js'

/**
 * Shared enable state for the toolbar icon and the in-editor hint, which
 * render in different slots. Shaped for React's useSyncExternalStore:
 * getSnapshot returns the same object until something changes.
 * @param {Storage | null | undefined} storage - preference storage for the explicit opt-in.
 */
export function createPredictionStore(storage) {
  const listeners = new Set()
  let enabled = readEnabled(storage)
  let settings = null
  let snapshot
  const rebuild = () => {
    snapshot = Object.freeze({
      enabled,
      settings,
      hostEnabled: settings?.enabled === true,
      // Unknown Host settings fail closed: no request before config arrives.
      active: enabled && settings?.enabled === true,
    })
  }
  const emit = () => {
    rebuild()
    for (const listener of [...listeners]) listener()
  }
  rebuild()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    toggle() {
      enabled = !enabled
      writeEnabled(storage, enabled)
      emit()
    },
    setSettings(next) {
      settings = next
      emit()
    },
  }
}
