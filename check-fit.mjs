// Renders the worst case - every point present, longest plausible values - and
// fails if it spills onto a second page. Run this after any edit to the layout.
import fs from 'node:fs'
import puppeteer from 'puppeteer'
import { COLUMNS, SUMMARY } from './lib/layout.mjs'
import { buildHTML } from './lib/report.mjs'

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'))
const A4_USABLE = 1123 - 20   // A4 at 96dpi minus body's bottom padding

// Fill in every id the layout can render, plus the header extras.
const values = { SNR: 12.5, STAR_RATING: 5, HEALTH_SCORE: 88 }
for (const col of COLUMNS) for (const sec of col) for (const r of sec.rows) {
  for (const id of r.pair ?? [r.id]) values[id] = 188.88
}
for (const s of SUMMARY) values[s.id] = 5

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
const rows = COLUMNS.flat().reduce((n, s) => n + s.rows.length, 0)
let failed = false

// Both languages, because the English captions are the longer ones and they get
// the same one-page budget.
for (const lang of ['TH', 'ENG']) {
const html = buildHTML({
  ticket: '888', measuredAt: '31/12/2026 23:59', values,
  eventName: CONFIG.eventName + ' — ทดสอบชื่องานที่ยาวมากเพื่อกันบรรทัดตก', inkSaver: CONFIG.inkSaver,
  showTicket: CONFIG.showTicket !== false,
  lang,
})

const page = await browser.newPage()
await page.setViewport({ width: 794, height: 1123 })
await page.setContent(html, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
const h = await page.evaluate(() => Math.round(document.querySelector('.smc').getBoundingClientRect().bottom))
// Any box that hides what does not fit is a box that can swallow text, and Thai
// stacks vowels and tone marks well above the x-height, so a line box sized for
// Latin loses them. Only boxes that actually clip count: .nm and .en bleed 3px
// past their row on purpose (padding out, margin back in) to give those marks
// room inside their own overflow:hidden, and that bleed is not a fault.
const clipped = await page.evaluate(() => {
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    if (el.tagName === 'IMG') continue
    const dy = el.scrollHeight - el.clientHeight
    const dx = el.scrollWidth - el.clientWidth
    if (el.clientHeight > 0 && dy > 1 && getComputedStyle(el).overflowY !== 'visible')
      bad.push(`ล้นลง ${dy}px: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 26)}"`)
    else if (el.clientWidth > 0 && dx > 1 && getComputedStyle(el).textOverflow !== 'ellipsis')
      bad.push(`ล้นข้าง ${dx}px: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 26)}"`)
  }
  return bad
})
await page.screenshot({ path: `check-fit-${lang}.png`, fullPage: true })
await page.close()

console.log(`[${lang}] กรณีข้อมูลครบ ${rows} แถว -> สูง ${h}px จากพื้นที่ ${A4_USABLE}px (เหลือ ${A4_USABLE - h}px)`)
if (clipped.length) {
  console.log('!! มีข้อความล้นกรอบ ' + clipped.length + ' จุด:')
  for (const c of clipped) console.log('   - ' + c)
  failed = true
}
if (h > A4_USABLE) { console.log('!! เกิน 1 หน้า'); failed = true }
}

await browser.close()
if (failed) process.exit(1)
console.log('OK - อยู่ใน 1 หน้า ทั้งสองภาษา')
