import { BASE, CHROME, pickTool } from './kw.mjs'
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import * as mupdf from 'mupdf'
const S = process.argv[2]
const browser = await chromium.launch({ executablePath: CHROME })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true })
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
const wait = (ms = 600) => page.waitForTimeout(ms)
const labels = () => page.$$eval('.viewer .page >> nth=0', () => 0).then(() => page.evaluate(() => [...document.querySelector('.viewer .page').querySelectorAll('.text-line')].map((b) => b.getAttribute('aria-label').replace('Edit text: ', ''))))
await page.goto(BASE)
await page.setInputFiles('input[type=file][accept="application/pdf,.pdf"]:not([multiple])', `${S}/test.pdf`)
await page.waitForSelector('.viewer .page:not(.page--loading)')
await pickTool(page, 'Edit existing text'); await wait()
console.log('hint:', (await page.textContent('.inspector__body .kw-muted')).slice(0, 50), '| lines:', JSON.stringify(await labels()))
const first = page.locator('.viewer .page').first()
await first.locator('.text-line').nth(2).click(); await wait(200)
console.log('editor value:', await page.inputValue('.line-editor__text'))
await page.keyboard.press('Control+a'); await page.keyboard.type('The quick RED fox jumps over the lazy cat.'); await page.keyboard.press('Enter'); await wait(1000)
console.log('after edit:', JSON.stringify(await labels()), '| dirty:', await page.textContent('.topbar__file .kw-badge'))
// Escape cancels
await first.locator('.text-line').first().click(); await page.keyboard.press('Control+a'); await page.keyboard.type('nope'); await page.keyboard.press('Escape'); await wait()
console.log('after escape:', JSON.stringify((await labels())[0]))
// unsupported character warning
await first.locator('.text-line').first().click(); await page.keyboard.press('End'); await page.keyboard.type(' ✓')
console.log('warning:', await page.textContent('.line-editor__warning').catch(() => 'NONE'))
await page.keyboard.press('Enter'); console.log('still editing after Enter:', await page.isVisible('.line-editor__text'))
await page.keyboard.press('Escape'); await wait()
// delete a line by clearing it
await first.locator('.text-line').nth(1).click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); await page.keyboard.press('Enter'); await wait(1000)
console.log('after delete:', JSON.stringify(await labels()))
await page.screenshot({ path: `${S}/70-edit.png` })
await page.keyboard.press('Control+z'); await wait(1000)
console.log('after undo:', JSON.stringify(await labels()))
// Restyle a line with the style bar: serif, 24 pt, bold, red; the text itself is unchanged.
await first.locator('.text-line').nth(2).click(); await wait(200)
console.log('style bar:', await page.isVisible('.line-editor__bar'), '| starts at:', await page.inputValue('.line-editor__font'), await page.inputValue('.line-editor__size input'), 'pt')
await page.selectOption('.line-editor__font', 'serif')
console.log('focus back on text after font change:', await page.evaluate(() => document.activeElement?.classList.contains('line-editor__text')))
await page.fill('.line-editor__size input', '24')
await page.click('.line-editor__bold')
await page.click('.line-editor__swatch[aria-label="Red"]')
console.log('still editing after bar clicks:', await page.isVisible('.line-editor__text'), '| preview:', await page.$eval('.line-editor__text', (el) => [el.style.fontFamily, el.style.fontWeight, el.style.color].join(' / ')))
await page.locator('.line-editor__text').press('Enter'); await wait(1000)
console.log('after restyle:', JSON.stringify(await labels()))
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button[title^="Export"]')])
const d = mupdf.Document.openDocument(fs.readFileSync(await dl.path()), 'application/pdf')
d.loadPage(0).toStructuredText().walk({ beginLine() { this.done = false }, onChar(c, _o, font, size, _q, color) { if (!this.done) { this.done = true; console.log('saved line:', font.getName(), Math.round(size), color.map((v) => v.toFixed(2)).join(',')) } } })
console.log('saved p1 text:', JSON.stringify(d.loadPage(0).toStructuredText().asText().replace(/\s+/g, ' ').trim()))
console.log('errors', errors)
await browser.close()
