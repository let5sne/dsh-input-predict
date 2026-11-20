import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')

test('published metadata is complete and not private', () => {
  assert.equal(pkg.name, '@let5sne/dsh-input-predict')
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.publishConfig.access, 'public')
  assert.ok(pkg.repository?.url.includes('let5sne/dsh-input-predict'))
})

test('the DSH range covers the whole 0.2.2 series rather than one prerelease build', () => {
  // A fixed prerelease pin made DSH silently skip this plugin after upgrading
  // from rc.3 to rc.5; keep the range broad within the verified minor.
  assert.equal(pkg.engines.dsh, '>=0.2.2-rc.3 <0.2.3-0')
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.match(range, /^>=0\.2\.2-rc\.3 </, `${name} must not pin one DSH build`)
  }
})

test('the changelog leads with the package version', () => {
  const first = changelog.match(/^## (\d+\.\d+\.\d+) — /m)
  assert.equal(first?.[1], pkg.version)
})
