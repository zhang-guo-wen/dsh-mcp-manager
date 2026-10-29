// Real Chromium geometry/interaction regression, fulfilled from local artifacts at a virtual origin.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(repo, '..')
const fixtureDir = join(workspace, '.scratch/test-system/mcp-roster-scroll-fixture')
const outputDir = join(workspace, '.scratch/test-system/mcp-roster-scroll')
const playwrightFile = process.env.DSH_TEST_PLAYWRIGHT ?? process.env.DSH_TASK_PLAYWRIGHT ?? join(workspace, '.scratch/pw-core/node_modules/playwright-core/index.mjs')
const chrome = [process.env.CHROME_PATH, process.env.Chrome_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(file => file && existsSync(file))
if (!chrome) throw new Error('Missing installed Chrome/Edge; set CHROME_PATH. No browser is downloaded.')
if (!existsSync(playwrightFile)) throw new Error('Missing Playwright; set DSH_TEST_PLAYWRIGHT or DSH_TASK_PLAYWRIGHT to an installed entrypoint')
const { chromium } = await import(pathToFileURL(playwrightFile).href)
const manifest = JSON.parse(await readFile(join(fixtureDir, 'manifest.json'), 'utf8'))
for (const input of manifest.inputs) {
  const actual = createHash('sha256').update(await readFile(resolve(workspace, input.path))).digest('hex')
  assert.equal(actual, input.sha256, `Fixture input changed after build: ${input.path}; rerun node tests/build-browser-fixture.mjs`)
}
const fixtureHash = createHash('sha256').update(await readFile(join(fixtureDir, 'fixture.js'))).digest('hex')
assert.equal(fixtureHash, manifest.artifact.sha256, 'Fixture artifact changed after build')
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ executablePath: chrome, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] })
const results = []
const errors = []
const report = { at: new Date().toISOString(), browser: browser.version(), executable: chrome, fixture: manifest, scenarios: results, errors,
  scope: 'Real McpSection/host controls/theme/SettingsRoot CSS in a routed fixture; no Host auth, remote service, DSH_HOME or daily GUI.',
  unverified: ['Native phone soft keyboard/safe-area behavior', 'Actual Cordis/settings host integration and authenticated GUI', 'MCP connectivity or network services'],
}
const origin = 'https://mcp-roster-fixture.invalid'
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function measure(page) {
  return page.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
    const region = document.querySelector('[role="region"][aria-label="Servers"]') ?? document.querySelector('[role="region"]')
    const options = document.getElementById('host-options')
    const title = [...document.querySelectorAll('h2')].find(el => el.textContent === 'MCP')
    const listTitle = [...document.querySelectorAll('h3')].find(el => el.textContent === 'Server list')
    const tabs = document.querySelector('[role="tablist"]')
    const add = [...document.querySelectorAll('button')].find(el => el.textContent === 'Add MCP')
    const search = document.querySelector('input[type="search"]')
    const picker = document.querySelector('button[aria-haspopup="menu"]')
    const rowElements = [...document.querySelectorAll('[data-mcp-name]')]
    const position = Object.fromEntries(Object.entries({ hostHeader: document.getElementById('host-header'), head: title?.parentElement, title, tabs, listTitle, add, search, picker }).map(([key, el]) => [key, el ? rect(el) : null]))
    const settings = document.querySelector('[data-scroll="settings"]')
    const scroll = el => ({ top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight, width: el.clientWidth, totalWidth: el.scrollWidth, overflow: getComputedStyle(el).overflowY })
    const scrollables = [...options.querySelectorAll('*')].filter(el => el.getBoundingClientRect().height > 0 && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)).map(el => ({ role: el.getAttribute('role'), label: el.getAttribute('aria-label'), className: el.className, ...scroll(el) }))
    return { position, region: { ...scroll(region), rect: rect(region), display: getComputedStyle(region).display, overscroll: getComputedStyle(region).overscrollBehaviorY }, options: scroll(options), ancestor: scroll(document.getElementById('fixture-ancestor')), pageTop: document.scrollingElement.scrollTop, bodyWidth: document.body.scrollWidth, viewportWidth: innerWidth, settings: { ...scroll(settings), hidden: settings.hidden }, rows: rowElements.map(el => ({ name: el.dataset.mcpName, rect: rect(el), shrink: getComputedStyle(el).flexShrink })), listDisplay: getComputedStyle(rowElements[0]?.parentElement ?? region).display, scrollables, theme: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-layer-2').trim(), transition: rowElements[0] ? getComputedStyle(rowElements[0]).transitionDuration : null }
  })
}
function sameChrome(before, after, label) {
  for (const [name, rect] of Object.entries(before.position)) {
    assert.ok(rect && after.position[name], `${label}: missing ${name}`)
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(rect[key] - after.position[name][key]) <= 0.1, `${label}: ${name}.${key} moved ${rect[key]} -> ${after.position[name][key]}`)
  }
  assert.equal(after.options.top, 0, `${label}: host options scrolled`)
  assert.equal(after.ancestor.top, 0, `${label}: outer ancestor scrolled`)
  assert.equal(after.pageTop, 0, `${label}: document scrolled`)
}
async function runScenario(options) {
  const { width, height = 900, dark = false, reduced = false, narrow = false, nav = false } = options
  const label = `${width}x${height}-${dark ? 'dark' : 'light'}-${reduced ? 'reduced' : 'motion'}${narrow ? '-narrow' : ''}${nav ? '-nav' : ''}`
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', reducedMotion: reduced ? 'reduce' : 'no-preference' })
  const page = await context.newPage()
  const scenario = { label, options, status: 'running', readings: {} }
  results.push(scenario)
  page.on('pageerror', error => errors.push({ label, message: error.message }))
  page.on('console', message => { if (message.type() === 'error') errors.push({ label, message: message.text() }) })
  await page.route('**/*', async route => {
    assert.equal(new URL(route.request().url()).origin, origin, 'Fixture must not reach a real network origin')
    const path = new URL(route.request().url()).pathname
    const name = path === '/fixture.js' ? 'fixture.js' : path === '/theme.css' ? 'theme.css' : 'index.html'
    await route.fulfill({ contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(join(fixtureDir, name)) })
  })
  await page.addInitScript(dark => { document.addEventListener('DOMContentLoaded', () => { if (dark) document.body.setAttribute('data-ds-dark-theme', '') }) }, dark)
  try {
    await page.goto(`${origin}/?count=80${narrow ? '&narrow=1' : ''}${nav ? '&nav=1' : ''}`)
    const region = page.getByRole('region')
    await page.waitForFunction(() => document.querySelectorAll('[data-mcp-name]').length === 80)
    await settle(page)
    const before = await measure(page)
    scenario.readings.initial = before
    assert.ok((before.theme !== '') && (!dark || await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))), `${label}: theme sheets or dark marker missing`)
    assert.equal(before.region.display, 'block', `${label}: roster body must remain block`)
    assert.equal(await region.getAttribute('aria-label'), 'Server list', `${label}: scroll region lacks list label`)
    assert.equal(await region.getAttribute('tabindex'), '0', `${label}: scroll region is not keyboard focusable`)
    assert.equal(before.listDisplay, 'flex', `${label}: roster list flex layout changed`)
    assert.ok(before.region.height >= 30, `${label}: no usable bounded list height (${before.region.height})`)
    assert.ok(before.region.total > before.region.height + 1000, `${label}: list did not overflow`)
    assert.ok(before.options.total <= before.options.height + 1, `${label}: host options itself overflows`)
    assert.equal(before.scrollables.length, 1, `${label}: expected only one scroll owner in roster`)
    assert.equal(before.scrollables[0].role, 'region', `${label}: region is not scroll owner`)
    assert.ok(before.bodyWidth <= width + 1, `${label}: horizontal document overflow`)
    const heights = before.rows.map(row => row.rect.height)
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 0.1, `${label}: row heights differ or shrink`)
    assert.ok(Math.min(...heights) >= 60, `${label}: rows collapsed below content height`)
    assert.equal(before.region.overscroll, 'contain', `${label}: list does not contain wheel chaining`)
    if (reduced) assert.equal(before.transition, '0s', `${label}: reduced motion row transition remains`)
    await region.hover()
    await page.mouse.wheel(0, 550)
    await page.waitForFunction(() => document.querySelector('[role="region"]').scrollTop > 100)
    await settle(page)
    const wheeled = await measure(page)
    sameChrome(before, wheeled, `${label}: wheel`)
    scenario.readings.wheelTop = wheeled.region.top
    await region.focus()
    await page.keyboard.press('PageDown')
    await page.waitForFunction(top => document.querySelector('[role="region"]').scrollTop > top, wheeled.region.top)
    await page.keyboard.press('End')
    await page.waitForFunction(() => { const r = document.querySelector('[role="region"]'); return Math.abs(r.scrollHeight - r.clientHeight - r.scrollTop) <= 1 })
    await settle(page)
    const bottom = await measure(page)
    sameChrome(before, bottom, `${label}: keyboard`)
    const last = bottom.rows.at(-1).rect
    assert.ok(last.bottom <= bottom.region.rect.bottom + 1 && last.bottom > bottom.region.rect.y, `${label}: last row not reachable`)
    await region.hover()
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(80)
    const chained = await measure(page)
    sameChrome(before, chained, `${label}: bottom wheel chain`)
    scenario.readings.bottom = { top: bottom.region.top, lastBottom: last.bottom, regionBottom: bottom.region.rect.bottom, outerTop: chained.ancestor.top }
    await page.getByRole('tab', { name: 'Settings', exact: true }).click()
    await settle(page)
    const settings = page.locator('[data-scroll="settings"]')
    await settings.hover()
    await page.mouse.wheel(0, 600)
    await page.waitForFunction(() => document.querySelector('[data-scroll="settings"]').scrollTop > 0)
    const settingsReading = await measure(page)
    assert.equal(settingsReading.options.top, 0, `${label}: settings moved host options`)
    assert.equal(settingsReading.ancestor.top, 0, `${label}: settings chained to ancestor`)
    assert.equal(settingsReading.scrollables.length, 1, `${label}: settings has multiple scroll owners`)
    assert.equal(settingsReading.scrollables[0].role, 'tabpanel', `${label}: settings tabpanel does not own scrolling`)
    scenario.readings.settingsTop = settingsReading.settings.top
    await page.getByRole('tab', { name: 'Servers', exact: true }).click()
    await settle(page)
    const returned = await measure(page)
    assert.ok(Math.abs(returned.region.top - bottom.region.top) <= 1, `${label}: tab switch lost roster scroll`)
    // Use a non-terminal position so the transient refreshing line cannot clamp the scroll offset.
    await region.evaluate(el => { el.scrollTop = 300 })
    const refreshBefore = await measure(page)
    const readsBefore = await page.evaluate(() => window.__mcpFixture.reads)
    await page.evaluate(() => { window.__mcpFixture.setDelay(120); return window.__mcpFixture.refresh() })
    const refreshing = await measure(page)
    sameChrome(before, refreshing, `${label}: in-flight refresh`)
    assert.ok(Math.abs(refreshing.region.top - refreshBefore.region.top) <= 1, `${label}: in-flight refresh lost scroll`)
    await page.waitForFunction(reads => window.__mcpFixture.reads > reads && !document.body.textContent.includes('Refreshing'), readsBefore)
    await page.waitForTimeout(150)
    await page.evaluate(() => { window.__mcpFixture.setDelay(20) })
    await settle(page)
    const refreshed = await measure(page)
    assert.ok(Math.abs(refreshed.region.top - refreshBefore.region.top) <= 1, `${label}: refresh lost scroll`)
    sameChrome(before, refreshed, `${label}: refresh`)
    await page.getByRole('searchbox').fill('standard_079')
    await page.waitForFunction(() => document.querySelectorAll('[data-mcp-name]').length === 1)
    const filtered = await measure(page)
    assert.ok(filtered.region.total <= filtered.region.height + 1, `${label}: one filtered row has excess scroll`)
    await page.getByRole('searchbox').fill('not-a-server')
    await page.waitForFunction(() => document.querySelectorAll('[data-mcp-name]').length === 0)
    const empty = await measure(page)
    assert.ok(empty.region.total <= empty.region.height + 1, `${label}: empty state has excess scroll`)
    await page.getByRole('searchbox').fill('')
    await page.waitForFunction(() => document.querySelectorAll('[data-mcp-name]').length === 80)
    await page.getByRole('button', { name: 'Filter by agent preset; global rows are listed too', exact: true }).click()
    await page.getByRole('menuitem', { name: /other/ }).click()
    await page.waitForFunction(() => document.querySelector('[data-mcp-name]')?.getAttribute('data-mcp-name') === 'other_000')
    const picked = await measure(page)
    assert.equal(picked.rows.length, 80, `${label}: preset picker lost rows`)
    await page.evaluate(() => window.__mcpFixture.refresh(1))
    await page.waitForFunction(() => document.querySelectorAll('[data-mcp-name]').length === 1)
    const short = await measure(page)
    assert.ok(short.region.total <= short.region.height + 1, `${label}: short list has excess scroll`)
    assert.ok(Math.abs(short.rows[0].rect.height - heights[0]) <= 0.1, `${label}: 80-row list shrank cards versus one-row baseline`)
    await page.evaluate(() => window.__mcpFixture.refresh(0))
    await page.waitForFunction(() => document.querySelectorAll('[data-mcp-name]').length === 0)
    const emptyRoster = await measure(page)
    assert.ok(emptyRoster.region.total <= emptyRoster.region.height + 1, `${label}: empty roster has excess scroll`)
    const ancestorControl = await page.evaluate(() => { const a = document.getElementById('fixture-ancestor'); const previous = a.scrollTop; a.scrollTop = 30; const accepted = a.scrollTop; a.scrollTop = previous; return accepted })
    assert.ok(ancestorControl > 0, `${label}: ancestor was not scrollable; wheel containment control invalid`)
    scenario.readings.short = { total: short.region.total, height: short.region.height, rowHeight: short.rows[0].rect.height }
    await page.evaluate(() => window.__mcpFixture.refresh(80))
    await page.waitForFunction(() => document.querySelectorAll('[data-mcp-name]').length === 80)
    if ((width === 1440 && dark && !narrow && !nav && !reduced) || (width === 390 && !dark && !reduced && !nav)) {
      const filename = `${label}.png`
      await page.screenshot({ path: join(outputDir, filename), fullPage: false })
      scenario.screenshot = join(outputDir, filename)
    }
    scenario.status = 'passed'
    console.log(`PASS ${label}: list=${before.region.height}px rows=${heights[0]}px scroll=${bottom.region.top}px`)
  } catch (error) {
    scenario.status = 'failed'
    scenario.error = error.stack ?? String(error)
    await page.screenshot({ path: join(outputDir, `FAIL-${label}.png`), fullPage: false }).catch(() => {})
    throw error
  } finally { await context.close() }
}
async function runCatalogScenario({ width, dark = false }) {
  const label = `catalog-controls-${width}-${dark ? 'dark' : 'light'}`
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light' })
  const page = await context.newPage()
  const scenario = { label, status: 'running', readings: {} }
  results.push(scenario)
  page.on('pageerror', error => errors.push({ label, message: error.message }))
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname
    const name = path === '/fixture.js' ? 'fixture.js' : path === '/theme.css' ? 'theme.css' : 'index.html'
    await route.fulfill({ contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(join(fixtureDir, name)) })
  })
  await page.addInitScript(dark => document.addEventListener('DOMContentLoaded', () => { if (dark) document.body.setAttribute('data-ds-dark-theme', '') }), dark)
  try {
    await page.goto(`${origin}/?count=2`)
    await page.getByRole('tab', { name: 'Settings', exact: true }).click()
    const cache = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Tool catalogue cache', exact: true }) })
    await cache.getByText('Catalogue state', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-optimize-field="catalogTtlMs"]').count(), 0, `${label}: manual TTL remains`)
    assert.equal(await page.evaluate(() => window.__mcpFixture.refreshCalls), 0, `${label}: render connected servers`)
    const refresh = cache.getByRole('button', { name: 'Refresh', exact: true })
    await refresh.click()
    await page.waitForFunction(() => window.__mcpFixture.refreshCalls === 1)
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent === 'Refresh'); return button && !button.disabled })
    assert.equal(await cache.getByText('local:fixture', { exact: true }).count(), 1, `${label}: local entry lost after server refresh`)
    assert.equal(await cache.getByText('server:fixture', { exact: true }).count(), 1, `${label}: server entry lost`)
    const box = await cache.boundingBox()
    assert.ok(box.width <= width, `${label}: cache group overflow`)
    scenario.readings = { refreshCalls: await page.evaluate(() => window.__mcpFixture.refreshCalls), catalogReads: await page.evaluate(() => window.__mcpFixture.catalogReads), cache: box }
    await cache.screenshot({ path: join(outputDir, `${label}.png`) })
    await cache.getByRole('button', { name: 'Clear cache', exact: true }).click()
    await page.waitForFunction(() => !document.body.textContent.includes('local:fixture'))
    scenario.status = 'passed'
    console.log(`PASS ${label}: state under cache heading, no manual TTL, explicit refresh only`)
  } catch (error) { scenario.status = 'failed'; scenario.error = String(error); throw error }
  finally { await context.close() }
}

async function runPresetNameScenario({ width, dark = false }) {
  const label = `preset-names-${width}-${dark ? 'dark' : 'light'}`
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light' })
  const page = await context.newPage()
  const scenario = { label, options: { width, dark, names: true }, status: 'running', readings: {} }
  results.push(scenario)
  page.on('pageerror', error => errors.push({ label, message: error.message }))
  page.on('console', message => { if (message.type() === 'error') errors.push({ label, message: message.text() }) })
  await page.route('**/*', async route => {
    assert.equal(new URL(route.request().url()).origin, origin, 'Name fixture must not reach a real network origin')
    const path = new URL(route.request().url()).pathname
    const name = path === '/fixture.js' ? 'fixture.js' : path === '/theme.css' ? 'theme.css' : 'index.html'
    await route.fulfill({ contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(join(fixtureDir, name)) })
  })
  await page.addInitScript(dark => { document.addEventListener('DOMContentLoaded', () => { if (dark) document.body.setAttribute('data-ds-dark-theme', '') }) }, dark)
  const ids = ['standard', 'ptc', 'minimal', 'cordis', 'research']
  const filter = () => page.locator('#host-options button[aria-haspopup="menu"]')
  const menuNames = () => page.getByRole('menuitem').allTextContents()
  const setLanguage = async language => {
    await page.evaluate(language => window.__mcpFixture.setLanguage(language), language)
    await page.waitForFunction(language => document.getElementById('fixture-ancestor').dataset.language === language, language)
    await settle(page)
  }
  const optionValues = target => target.locator('option').evaluateAll(options => options.map(option => option.value))
  const optionNames = target => target.locator('option').allTextContents()
  try {
    await page.goto(`${origin}/?names=1`)
    await page.waitForFunction(() => document.querySelector('[data-mcp-name]')?.getAttribute('data-mcp-name') === 'standard_000')
    await settle(page)
    const expected = await page.evaluate(() => ({ zh: window.__mcpFixture.hostNames('zh'), en: window.__mcpFixture.hostNames('en') }))
    scenario.readings.hostDictionaryNames = expected
    const reads = await page.evaluate(() => window.__mcpFixture.reads)
    assert.equal(await page.evaluate(() => window.__mcpFixture.language), 'zh', `${label}: names mode must start in Chinese`)
    assert.equal((await filter().textContent()).trim(), expected.zh.standard, `${label}: initial name differs from Host dictionary`)
    assert.equal(await page.locator('[data-mcp-name="standard_000"]').getByText(expected.zh.standard, { exact: true }).count(), 1, `${label}: initial scope chip is not localized`)
    await filter().click()
    assert.deepEqual((await menuNames()).map(name => name.trim()), ids.map(id => expected.zh[id]), `${label}: Chinese menu copy must exactly match Host dictionaries`)
    await page.getByRole('menuitem', { name: expected.zh.ptc, exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-mcp-name]')?.getAttribute('data-mcp-name') === 'ptc_000')
    assert.equal((await filter().textContent()).trim(), expected.zh.ptc, `${label}: raw ptc selection did not retain Chinese label`)
    assert.equal(await page.locator('[data-mcp-name="ptc_000"]').getByText(expected.zh.ptc, { exact: true }).count(), 1, `${label}: ptc card scope chip is not Chinese`)
    const screenshots = []
    const capture = async suffix => { const filename = `${label}-${suffix}.png`; await page.screenshot({ path: join(outputDir, filename), fullPage: false }); screenshots.push(join(outputDir, filename)) }
    await filter().click()
    await capture('zh-menu')
    await setLanguage('en')
    assert.deepEqual((await menuNames()).map(name => name.trim()), ids.map(id => expected.en[id]), `${label}: already-open menu did not update in English`)
    assert.equal((await filter().textContent()).trim(), expected.en.ptc, `${label}: active selection did not update in English`)
    assert.equal(await page.getByRole('menuitem', { name: expected.en.ptc, exact: true }).locator('svg').count(), 1, `${label}: locale change lost ptc selection marker`)
    assert.equal(await page.locator('[data-mcp-name="ptc_000"]').getByText(expected.en.ptc, { exact: true }).count(), 1, `${label}: scope chip did not update in English`)
    assert.equal(await page.locator('[data-mcp-name="ptc_000"]').count(), 1, `${label}: locale change replaced raw filter id`)
    assert.equal(await page.evaluate(() => window.__mcpFixture.reads), reads, `${label}: language change re-read the roster`)
    await capture('en-menu')
    await page.keyboard.press('Escape')
    await setLanguage('zh')
    await page.getByRole('button', { name: '新增 MCP', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '新增 MCP 服务器', exact: true })
    let target = dialog.getByRole('combobox', { name: '配置范围', exact: true })
    await page.waitForFunction(() => document.querySelector('[role="dialog"] select')?.options.length === 6)
    assert.deepEqual(await optionValues(target), ['', ...ids], `${label}: localized target option values must stay raw ids`)
    assert.deepEqual((await optionNames(target)).map(name => name.trim()), ['全局', ...ids.map(id => `预设 · ${expected.zh[id]}`)], `${label}: add target labels differ from Chinese Host names`)
    assert.equal(await target.inputValue(), 'ptc', `${label}: add target lost current raw ptc id`)
    await setLanguage('en')
    dialog = page.getByRole('dialog', { name: 'Add MCP server', exact: true })
    target = dialog.getByRole('combobox', { name: 'Config scope', exact: true })
    assert.equal(await target.inputValue(), 'ptc', `${label}: target locale update changed its value`)
    assert.deepEqual(await optionValues(target), ['', ...ids], `${label}: English target option values changed`)
    assert.deepEqual((await optionNames(target)).map(name => name.trim()), ['Global', ...ids.map(id => `Preset · ${expected.en[id]}`)], `${label}: add target labels did not live-update to English`)
    await target.selectOption('research')
    await setLanguage('zh')
    dialog = page.getByRole('dialog', { name: '新增 MCP 服务器', exact: true })
    target = dialog.getByRole('combobox', { name: '配置范围', exact: true })
    assert.equal(await target.inputValue(), 'research', `${label}: custom target id changed on locale update`)
    assert.equal(await target.locator('option[value="research"]').textContent(), '预设 · Research Agent', `${label}: authored target name was translated`)
    await capture('zh-add-target')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    // Card padding is the edit affordance; its centered point can hit the inline description control on narrow layouts.
    await page.locator('[data-mcp-name="ptc_000"]').click({ position: { x: 10, y: 10 } })
    dialog = page.getByRole('dialog', { name: '编辑 MCP 服务器', exact: true })
    await dialog.getByRole('textbox', { name: '服务器名', exact: true }).waitFor()
    await page.waitForFunction(name => [...document.querySelectorAll('[role="dialog"] span')].some(span => span.textContent === `预设 · ${name}`), expected.zh.ptc)
    assert.equal(await dialog.getByText(`预设 · ${expected.zh.ptc}`, { exact: true }).count(), 1, `${label}: edit scope must use Chinese Host name`)
    await page.waitForFunction(() => document.querySelector('[role="dialog"] input[aria-label="服务器名"]')?.value === 'ptc_000')
    assert.equal(await dialog.getByRole('textbox', { name: '服务器名', exact: true }).inputValue(), 'ptc_000', `${label}: editing must keep the raw MCP namespace`)
    await setLanguage('en')
    dialog = page.getByRole('dialog', { name: 'Edit MCP server', exact: true })
    assert.equal(await dialog.getByText(`Preset · ${expected.en.ptc}`, { exact: true }).count(), 1, `${label}: edit scope did not live-update to English`)
    assert.equal(await dialog.getByRole('textbox', { name: 'Server name', exact: true }).inputValue(), 'ptc_000', `${label}: locale change altered edited MCP identity`)
    await capture('en-edit-scope')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await filter().click()
    await page.getByRole('menuitem', { name: 'Research Agent', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-mcp-name]')?.getAttribute('data-mcp-name') === 'research_000')
    assert.equal((await filter().textContent()).trim(), 'Research Agent', `${label}: custom filter label changed`)
    assert.equal(await page.locator('[data-mcp-name="research_000"]').getByText('Research Agent', { exact: true }).count(), 1, `${label}: custom scope chip changed`)
    await setLanguage('zh')
    assert.equal((await filter().textContent()).trim(), 'Research Agent', `${label}: Chinese locale translated custom name`)
    assert.equal(await page.locator('[data-mcp-name="research_000"]').count(), 1, `${label}: custom raw id changed`)
    assert.equal(await page.evaluate(() => window.__mcpFixture.reads), reads, `${label}: name rerenders must not re-read roster`)
    scenario.readings = { ...scenario.readings, rawPresetIds: ids, finalSelectedId: 'research', initialRosterReads: reads, finalRosterReads: await page.evaluate(() => window.__mcpFixture.reads), screenshots }
    scenario.status = 'passed'
    console.log(`PASS ${label}: Host names zh/en, live menu/chip/add/edit, raw ids, roster reads=${reads}`)
  } catch (error) {
    scenario.status = 'failed'
    scenario.error = error.stack ?? String(error)
    await page.screenshot({ path: join(outputDir, `FAIL-${label}.png`), fullPage: false }).catch(() => {})
    throw error
  } finally { await context.close() }
}
try {
  const widths = [320, 360, 390, 430, 600, 601, 760, 761, 1024, 1280, 1440]
  const limit = process.env.DSH_MCP_SCROLL_QUICK === '1' ? [1440] : widths
  for (const width of limit) for (const dark of [false, true]) for (const reduced of [false, true]) await runScenario({ width, dark, reduced })
  for (const options of [{ width: 1440, narrow: true }, { width: 1440, nav: true }, { width: 390, height: 560 }, { width: 1440, height: 420 }, { width: 761, height: 560, dark: true }]) await runScenario(options)
  for (const options of [{ width: 1440 }, { width: 390, dark: true }]) await runPresetNameScenario(options)
  for (const options of [{ width: 1440 }, { width: 390, dark: true }]) await runCatalogScenario(options)
  assert.equal(errors.length, 0, 'Browser console/page errors were recorded')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  await browser.close()
  const filename = join(outputDir, `readings-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`)
  await writeFile(filename, JSON.stringify(report, null, 2))
  await writeFile(join(outputDir, 'latest.json'), JSON.stringify(report, null, 2))
  console.log(`Readings: ${filename}`)
  if (report.failure) console.error(report.failure)
}
