import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
for (const dir of ['host', 'web', 'scripts']) {
  for (const name of readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' })
    assert.equal(result.status, 0, `${dir}/${name} syntax`)
  }
}
for (const name of ['index.js', 'client.js']) {
  assert.equal(spawnSync(process.execPath, ['--check', name], { stdio: 'inherit' }).status, 0)
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
assert.equal(pkg.private, undefined, 'a published package must not be private')
assert.equal(pkg.license, 'MIT')
for (const path of ['LICENSE', 'CHANGELOG.md']) assert.ok(existsSync(path), path)
assert.ok(readFileSync('client.js', 'utf8').includes(`id:${JSON.stringify(pkg.name)}`), 'client module id must match the package name')
assert.ok(readFileSync(pkg.dsh.bundle.patch, 'utf8').includes(pkg.name), 'bundle patch must insert this package')
for (const path of Object.values(pkg.exports).filter(path => !path.includes('*'))) assert.ok(existsSync(path), path)
assert.ok(existsSync(pkg.dsh.bundle.patch))
for (const language of ['en', 'zh']) {
  const locale = JSON.parse(readFileSync(`locale/${language}.json`, 'utf8'))
  assert.ok(locale.meta.title && locale.meta.description)
}
console.log('JavaScript syntax, package exports and display resources verified.')
