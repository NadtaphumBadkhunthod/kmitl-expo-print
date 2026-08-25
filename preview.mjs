// Render one report to preview.pdf without touching the printer.
//
//   node preview.mjs "<url or payload from a QR>"
//
// Use this to check the layout, the Thai fonts and the ink-saver look before the
// event, and to sanity-check a QR that the station refused.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'
import { decode } from './lib/decode.mjs'
import { buildHTML } from './lib/report.mjs'
import { buildQR } from './lib/qr.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))

const scanned = process.argv[2]
if (!scanned) {
  console.error('ใช้: node preview.mjs "<ลิงก์จาก QR>"')
  process.exit(1)
}

const { measuredAt, values } = decode(scanned)
console.log('วัดเมื่อ:', measuredAt, '| ถอดค่าได้', Object.keys(values).length, 'ค่า')

const qr = await buildQR(CONFIG, scanned)
const html = buildHTML({
  ticket: '000',
  measuredAt,
  values,
  qrDataUrl: qr.dataUrl,
  qrBig: qr.big,
  eventName: CONFIG.eventName,
  inkSaver: CONFIG.inkSaver,
  showTicket: CONFIG.showTicket !== false,
})

fs.writeFileSync(path.join(ROOT, 'preview.html'), html)

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setContent(html, { waitUntil: 'load' })
await page.pdf({ path: path.join(ROOT, 'preview.pdf'), format: 'A4', printBackground: true })

// A4 at 96dpi minus the @page margins declared in report.mjs.
const usable = 1123 - 20   // A4 at 96dpi minus body's bottom padding
const height = await page.evaluate(() => Math.round(document.querySelector('.smc').getBoundingClientRect().bottom))
const clipped = await page.evaluate(() =>
  [...document.querySelectorAll('.nm,.en')].filter(e => e.scrollWidth > e.clientWidth + 1)
    .map(e => e.textContent.trim()))
await browser.close()

console.log('เขียน preview.pdf และ preview.html แล้ว')
console.log(`สูง ${height}px จากพื้นที่ ${usable}px (เหลือ ${usable - height}px)`)
if (clipped.length) console.log('!! ชื่อโดนตัด:', clipped.join(' | '))
if (height > usable) console.log('!! เกิน 1 หน้า — ลดขนาดฟอนต์ใน lib/report.mjs หรือตัดหัวข้อออก')
console.log('ตรวจกรณีข้อมูลครบทุกตัวด้วย: node check-fit.mjs')
