import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const require = createRequire(pathToFileURL(resolve(root, 'package.json')))
const readLocale = language => JSON.parse(readFileSync(require.resolve(`${manifest.name}/locale/${language}.json`), 'utf8')).meta

test('display metadata exports both languages with an unscoped English fallback', () => {
  assert.equal(manifest.exports['./locale/*'], './locale/*')
  assert.equal(manifest.exports['./package.json'], './package.json')
  assert.ok(manifest.files.includes('locale'))
  assert.deepEqual(readdirSync(resolve(root, 'locale')).sort(), ['en.json', 'zh.json'])
  const en = readLocale('en')
  const zh = readLocale('zh')
  assert.equal(en.title, manifest.name.replace(/^@[^/]+\//, ''))
  assert.ok(!en.title.includes('@') && !zh.title.includes('@'))
  assert.match(zh.title, /\p{Script=Han}/u)
  for (const meta of [en, zh]) {
    assert.deepEqual(Object.keys(meta).sort(), ['description', 'title'])
    for (const field of ['title', 'description']) assert.ok(typeof meta[field] === 'string' && meta[field].trim())
  }
  assert.doesNotMatch(en.description, /\p{Script=Han}/u)
  assert.match(zh.description, /\p{Script=Han}/u)
  // Harness resolves locale maps using English when the selected language has no translation.
  const titles = { en: en.title, zh: zh.title }
  assert.equal(titles.en, en.title)
  assert.equal(titles.zh, zh.title)
  assert.equal(titles.fr ?? titles.en, en.title)
})

test('bundle patch defers to an earlier row that already mounts this plugin', () => {
  const patch = readFileSync(resolve(root, manifest.dsh.bundle.patch), 'utf8')
  const id = /- id: (.+)/u.exec(patch)?.[1]?.trim()
  assert.ok(id, 'the patch declares its own row id')
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'the row names this package')
  assert.match(patch, /disabled: !!js "/u, 'the row carries a !!js guard')
  assert.ok(patch.includes(`e.options.name === '${manifest.name}'`), 'the guard looks this package up by module name')
  assert.ok(patch.includes(`e.options.id !== '${id}'`), 'the guard excludes its own row')
  assert.match(patch, /!e\.disabled/u, 'the guard only defers to a row that is actually mounted')
})
