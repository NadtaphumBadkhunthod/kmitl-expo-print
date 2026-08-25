// Renders the worst case - every point present, longest plausible values - and
// fails if it spills onto a second page. Run this after any edit to the layout.
import fs from 'node:fs'
import puppeteer from 'puppeteer'
import { buildQR } from './lib/qr.mjs'
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

// Use the real QR path: result mode needs a taller header, so testing with a
// stand-in code would miss the case that actually overflows.
const LONG_URL = 'https://aqn.iamhtlife.com:8382/?r=' + 'A'.repeat(360)
const qr = await buildQR(CONFIG, LONG_URL)
const html = buildHTML({
  ticket: '888', measuredAt: '31/12/2026 23:59', values,
  qrDataUrl: qr.dataUrl, qrBig: qr.big,
  eventName: CONFIG.eventName + ' — ทดสอบชื่องานที่ยาวมากเพื่อกันบรรทัดตก', inkSaver: CONFIG.inkSaver,
  showTicket: CONFIG.showTicket !== false,
})

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 794, height: 1123 })
await page.setContent(html, { waitUntil: 'load' })
const h = await page.evaluate(() => Math.round(document.querySelector('.smc').getBoundingClientRect().bottom))
// Any element whose content is taller or wider than its box is printing text
// on top of its neighbour. Fixed heights sized for Latin do this constantly once
// Thai vowels and tone marks are involved, so check every box, every render.
const clipped = await page.evaluate(() => {
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    if (el.tagName === 'IMG') continue
    const dy = el.scrollHeight - el.clientHeight
    const dx = el.scrollWidth - el.clientWidth
    if (el.clientHeight > 0 && dy > 1)
      bad.push(`ล้นลง ${dy}px: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 26)}"`)
    else if (el.clientWidth > 0 && dx > 1 && getComputedStyle(el).textOverflow !== 'ellipsis')
      bad.push(`ล้นข้าง ${dx}px: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 26)}"`)
  }
  return bad
})
await page.screenshot({ path: 'check-fit.png', fullPage: true })
await browser.close()

const rows = COLUMNS.flat().reduce((n, s) => n + s.rows.length, 0)
console.log(`กรณีข้อมูลครบ ${rows} แถว -> สูง ${h}px จากพื้นที่ ${A4_USABLE}px (เหลือ ${A4_USABLE - h}px)`)
if (clipped.length) {
  console.log('!! มีข้อความล้นกรอบ ' + clipped.length + ' จุด:')
  for (const c of clipped) console.log('   - ' + c)
}
if (h > A4_USABLE) { console.log('!! เกิน 1 หน้า'); process.exit(1) }
if (clipped.length) process.exit(1)
console.log('OK - อยู่ใน 1 หน้า')
