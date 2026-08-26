// KMITL Expo - QR -> A4 print station.
//
// Phone scans the visitor's QR, POSTs it here, this box decodes it locally,
// renders an A4 report and pushes it at the printer. Nothing here talks to the
// internet: the QR carries the whole result set, so the venue wifi can die and
// the booth keeps running.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import express from 'express'
import puppeteer from 'puppeteer'
import selfsigned from 'selfsigned'
import QRCode from 'qrcode'
import pdfToPrinter from 'pdf-to-printer'   // CommonJS - no named exports

import { decode } from './lib/decode.mjs'
import { buildHTML } from './lib/report.mjs'
import * as printer from './lib/printer.mjs'

const { print: printPDF } = pdfToPrinter

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(ROOT, 'config.json')
const LOG = path.join(ROOT, 'logs', 'scans.csv')

let CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
const saveConfig = () =>
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2) + '\n')

/* ---------------------------------------------------------------- state --- */

let ticketSeq = 0
const byPayload = new Map()   // payload -> job, for duplicate scans
const byTicket = new Map()    // ticket  -> job, for reprints and cancels
const pending = []            // decoded, waiting to be rendered
const ready = []              // rendered, waiting for the printer
let browser = null
const stats = { printed: 0, failed: 0, dup: 0, cancelled: 0 }

// Staff phones, so the control page can show how many are actually live.
const devices = new Map()
const DEVICE_TTL = 20000

const pad = n => String(n).padStart(3, '0')
const now = () => new Date().toLocaleTimeString('th-TH')

/* --------------------------------------------------------------- render --- */

async function renderPDF(job) {
  const html = buildHTML({
    ticket: job.ticket,
    measuredAt: job.measuredAt,
    values: job.values,
    eventName: CONFIG.eventName,
    inkSaver: CONFIG.inkSaver,
    showTicket: CONFIG.showTicket !== false,
  })

  const page = await browser.newPage()
  try {
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)   // never print with fallback glyphs
    const file = path.join(ROOT, 'tmp', job.ticket + '.pdf')
    await page.pdf({ path: file, format: 'A4', printBackground: true })
    return file
  } finally {
    await page.close()
  }
}

/* ---------------------------------------------------------------- queue --- */
// Two stages running side by side. Rendering is CPU (Chromium) and printing is
// mostly waiting on the spooler, so doing them strictly one after another wastes
// the whole render time on every visitor. The printer stage stays strictly
// serial - two jobs at the spooler at once is how you get interleaved pages and
// a staff member holding someone else's report.

const LOOKAHEAD = 3   // rendered-but-unprinted PDFs to keep on disk

function enqueue(job) {
  pending.push(job)
  pumpRender()
}

let renderingJob = null
let rendering = false
async function pumpRender() {
  if (rendering) return
  rendering = true
  while (pending.length && ready.length < LOOKAHEAD) {
    const job = renderingJob = pending.shift()
    try {
      if (job.state === 'cancelled') continue
      job.state = 'rendering'
      job.file = await renderPDF(job)
      if (job.state === 'cancelled') { dropFile(job); continue }
      ready.push(job)
      pumpPrint()
    } catch (err) {
      finish(job, err)
    } finally {
      renderingJob = null
    }
  }
  rendering = false
}

let printingJob = null
let printing = false
async function pumpPrint() {
  if (printing) return
  printing = true
  while (ready.length) {
    const job = printingJob = ready.shift()
    try {
      if (job.state === 'cancelled') { dropFile(job); continue }
      job.state = 'printing'
      if (CONFIG.dryRun) await new Promise(r => setTimeout(r, 400))
      else {
        // "Microsoft Print to PDF" and friends open a Save-As dialog that nobody
        // is standing in front of, so the print just hangs and then fails. Say so
        // rather than letting SumatraPDF's command line be the error message.
        if (lastPrinterState?.virtual)
          throw new Error('"' + CONFIG.printer + '" พิมพ์ลงไฟล์ ไม่ออกกระดาษ — เลือกเครื่องพิมพ์จริงที่หน้าควบคุม')
        await printPDF(job.file, { printer: CONFIG.printer, ...(CONFIG.printOptions ?? {}) })
      }
      finish(job, null)
    } catch (err) {
      finish(job, err)
    } finally {
      printingJob = null
    }
    pumpRender()   // a slot just freed up
  }
  printing = false
}

function dropFile(job) {
  if (job.file && !CONFIG.keepPDFs) fs.unlink(job.file, () => {})
  job.file = undefined
}

/** SumatraPDF reports failures as its own command line; nobody can act on that. */
function printError(message) {
  if (/SumatraPDF/i.test(message))
    return 'สั่งพิมพ์ไม่สำเร็จ — เครื่องพิมพ์ไม่ตอบสนอง เช็คว่าเปิดอยู่ ต่อสายแล้ว และไม่ใช่เครื่องพิมพ์ลงไฟล์'
  return message
}

function finish(job, err) {
  if (err) {
    job.state = 'failed'
    job.error = printError(err.message)
    // The phone that scanned it is the one holding the visitor, so make sure the
    // failure reaches that screen and not just the laptop.
    if (job.device) {
      const d = devices.get(job.device)
      if (d) d.lastFailure = { ticket: job.ticket, error: job.error, at: Date.now() }
    }
    stats.failed++
    console.error('  [' + job.ticket + '] ไม่สำเร็จ: ' + err.message)
  } else {
    job.state = 'done'
    stats.printed++
    console.log('  [' + job.ticket + '] พิมพ์แล้ว  (คิวเหลือ ' + queueDepth() + ')')
  }
  dropFile(job)
  appendLog(job)
}

const queueDepth = () =>
  pending.length + ready.length + (renderingJob ? 1 : 0) + (printingJob ? 1 : 0)

/** A job can still be pulled back until the moment it goes to the spooler. */
const cancellable = job => job && (job.state === 'queued' || job.state === 'rendering')

function appendLog(job) {
  const cells = [job.ticket, job.at, job.measuredAt, job.state,
                 job.values.HEALTH_SCORE ?? '', (job.error ?? '').replace(/[",\n]/g, ' '),
                 job.device ?? '', job.scanned]
  const line = cells.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n'
  fs.appendFile(LOG, line, err => err && console.error('เขียน log ไม่สำเร็จ:', err.message))
}

/* -------------------------------------------------------------- devices --- */

function touchDevice(req, body = {}) {
  const id = String(body.device ?? req.get('x-device-id') ?? '').slice(0, 40)
  if (!id) return null
  const d = devices.get(id) ?? { id, scans: 0, since: Date.now() }
  d.lastSeen = Date.now()
  d.name = String(body.name ?? d.name ?? '').slice(0, 40)
  d.ip = (req.ip ?? '').replace('::ffff:', '')
  devices.set(id, d)
  return d
}

const liveDevices = () =>
  [...devices.values()].filter(d => Date.now() - d.lastSeen < DEVICE_TTL)

/* ------------------------------------------------------------------ api --- */

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '64kb' }))
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h' }))

app.post('/api/hello', (req, res) => {
  const d = touchDevice(req, req.body)
  res.json({ ok: true, device: d?.id ?? null, devices: liveDevices().length })
})

app.post('/api/print', (req, res) => {
  const scanned = String(req.body?.scanned ?? '').trim()
  const device = touchDevice(req, req.body)
  if (!scanned) return res.status(400).json({ ok: false, error: 'ไม่มีข้อมูลที่สแกน' })

  let decoded
  try {
    decoded = decode(scanned)
  } catch (err) {
    return res.status(422).json({ ok: false, error: err.message })
  }

  // Same payload again: the camera fires many times a second, and two staff can
  // walk the same queue. Report the original ticket instead of reprinting.
  //
  // But only when that first attempt actually produced paper. A failed or
  // cancelled job used to stay in this map, so the one visitor whose print went
  // wrong was the one person the station then refused to serve.
  const prior = byPayload.get(decoded.payload)
  const retryable = prior && (prior.state === 'failed' || prior.state === 'cancelled')
  if (prior && !retryable && !req.body?.force) {
    stats.dup++
    return res.json({ ok: true, duplicate: true, ticket: prior.ticket, queued: queueDepth() })
  }

  const job = {
    ticket: pad(++ticketSeq),
    at: new Date().toLocaleString('th-TH'),
    scanned,
    measuredAt: decoded.measuredAt,
    values: decoded.values,
    state: 'queued',
    device: device?.id ?? null,
  }
  if (device) device.scans++
  byPayload.set(decoded.payload, job)
  byTicket.set(job.ticket, job)
  enqueue(job)

  console.log('[' + job.ticket + '] รับคิวแล้ว  วัดเมื่อ ' + job.measuredAt +
              '  คะแนน ' + (job.values.HEALTH_SCORE ?? '-') +
              (retryable ? '  (ลองใหม่จากคิว ' + prior.ticket + ' ที่' +
                           (prior.state === 'failed' ? 'ล้มเหลว' : 'ถูกยกเลิก') + ')' : ''))
  res.json({ ok: true, ticket: job.ticket, queued: queueDepth(), retryOf: retryable ? prior.ticket : null })
})

app.post('/api/cancel/:ticket', (req, res) => {
  const job = byTicket.get(req.params.ticket)
  if (!job) return res.status(404).json({ ok: false, error: 'ไม่พบคิวนี้' })
  if (!cancellable(job))
    return res.status(409).json({ ok: false, state: job.state,
      error: job.state === 'printing' ? 'ส่งเข้าเครื่องพิมพ์ไปแล้ว ยกเลิกที่หน้าควบคุม'
           : job.state === 'done' ? 'พิมพ์ไปแล้ว' : 'ยกเลิกไม่ได้' })

  job.state = 'cancelled'
  const i = pending.indexOf(job)
  if (i >= 0) pending.splice(i, 1)
  const j = ready.indexOf(job)
  if (j >= 0) ready.splice(j, 1)
  dropFile(job)
  stats.cancelled++
  console.log('[' + job.ticket + '] ยกเลิกแล้ว')
  res.json({ ok: true, ticket: job.ticket })
})

app.post('/api/reprint/:ticket', (req, res) => {
  const src = byTicket.get(req.params.ticket)
  if (!src) return res.status(404).json({ ok: false, error: 'ไม่พบคิวนี้' })
  const job = { ...src, ticket: pad(++ticketSeq), at: new Date().toLocaleString('th-TH'),
                state: 'queued', file: undefined, error: undefined }
  byTicket.set(job.ticket, job)
  enqueue(job)
  res.json({ ok: true, ticket: job.ticket, reprintOf: src.ticket, queued: queueDepth() })
})

app.get('/api/status', (req, res) => {
  const d = touchDevice(req, {})
  // Surface a failure once, then clear it, so the phone shows it exactly once.
  let failure = null
  if (d?.lastFailure && Date.now() - d.lastFailure.at < 60000) {
    failure = d.lastFailure
    d.lastFailure = null
  }
  res.json({
    printed: stats.printed, failed: stats.failed, dup: stats.dup, cancelled: stats.cancelled,
    queued: queueDepth(),
    devices: liveDevices().length,
    printer: CONFIG.printer || null,
    printerOk: lastPrinterState?.ok ?? null,
    printerVirtual: !!lastPrinterState?.virtual,
    dryRun: !!CONFIG.dryRun,
    failure,
  })
})

/* ------------------------------------------------------- control plane --- */
// Polling the spooler is slow (a PowerShell round trip), so refresh it on a timer
// and hand the control page whatever the last sweep saw.

let lastPrinterState = null
let sweepInFlight = null

/**
 * A sweep is a PowerShell round trip, so it is slow enough that the selected
 * printer can change while one is running. Each sweep therefore remembers which
 * printer it was asked about and throws its answer away if that is no longer the
 * selection - otherwise picking a new printer shows the old one's status, and the
 * guard that refuses to print into a Save-As dialog reads the wrong printer.
 */
async function sweepPrinter({ force = false } = {}) {
  if (!CONFIG.printer) { lastPrinterState = null; return }
  if (sweepInFlight && !force) return sweepInFlight

  const target = CONFIG.printer
  const p = (async () => {
    let state
    try {
      state = { ...(await printer.status(target)), at: now() }
    } catch (err) {
      state = { name: target, found: false, error: err.message, at: now() }
    }
    if (target === CONFIG.printer) lastPrinterState = state
    if (sweepInFlight === p) sweepInFlight = null
  })()
  sweepInFlight = p
  return p
}

app.get('/api/control', (_req, res) => res.json({
  config: {
    printer: CONFIG.printer || '', eventName: CONFIG.eventName, inkSaver: !!CONFIG.inkSaver,
    dryRun: !!CONFIG.dryRun, showTicket: CONFIG.showTicket !== false,
  },
  stats: { ...stats, queued: queueDepth() },
  printer: lastPrinterState,
  devices: liveDevices().map(d => ({
    id: d.id, name: d.name, ip: d.ip, scans: d.scans,
    idle: Math.round((Date.now() - d.lastSeen) / 1000),
  })),
  jobs: [...byTicket.values()].slice(-14).reverse().map(j => ({
    ticket: j.ticket, at: j.at, state: j.state, error: j.error ?? null,
    score: j.values.HEALTH_SCORE ?? null, cancellable: cancellable(j),
  })),
}))

// The control page shows this as a big QR so staff can point a phone at the
// laptop screen instead of typing an IP address.
app.get('/api/joinqr', async (_req, res) => {
  const url = joinURL()
  res.json({
    url,
    dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 420 }),
    // If the top-ranked adapter is the wrong one, staff need the others to try.
    alternates: lanAddresses().slice(1).map(a =>
      ({ url: 'https://' + a.ip + ':' + CONFIG.port, adapter: a.name, virtual: a.virtual })),
  })
})

app.get('/api/printers', async (_req, res) => {
  try {
    res.json({ ok: true, printers: await printer.list(), selected: CONFIG.printer || '' })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/config', async (req, res) => {
  const patch = req.body ?? {}
  if (typeof patch.printer === 'string') {
    const names = (await printer.list().catch(() => [])).map(p => p.name)
    if (patch.printer && names.length && !names.includes(patch.printer))
      return res.status(400).json({ ok: false, error: 'ไม่พบเครื่องพิมพ์ชื่อนี้' })
    CONFIG.printer = patch.printer
    lastPrinterState = null
    // Force a fresh sweep and wait for it: the guard that refuses to "print" into
    // a Save-As dialog reads this state, and a scan can arrive immediately.
    await sweepPrinter({ force: true })
  }
  for (const k of ['inkSaver', 'dryRun', 'showTicket']) if (k in patch) CONFIG[k] = !!patch[k]
  if (typeof patch.eventName === 'string') CONFIG.eventName = patch.eventName.slice(0, 60)
  saveConfig()
  console.log('ตั้งค่าใหม่:', JSON.stringify(patch))
  res.json({ ok: true, config: CONFIG })
})

app.post('/api/printer/:action', async (req, res) => {
  const name = CONFIG.printer
  if (!name) return res.status(400).json({ ok: false, error: 'ยังไม่ได้เลือกเครื่องพิมพ์' })
  try {
    const { action } = req.params
    if (action === 'pause') await printer.pause(name)
    else if (action === 'resume') await printer.resume(name)
    else if (action === 'clear') await printer.cancelAll(name)
    else if (action === 'job') await printer.cancelJob(name, req.body?.id)
    else if (action !== 'refresh') return res.status(404).json({ ok: false, error: 'ไม่รู้จักคำสั่งนี้' })
    await sweepPrinter()
    res.json({ ok: true, printer: lastPrinterState })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

/* ----------------------------------------------------------------- boot --- */

// A Hyper-V/WSL switch has a perfectly valid IPv4 address that no phone on the
// wifi can route to - and on this machine it sorts first. Rank the adapters so
// the QR and the printed URL point at one a phone can actually reach.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Bluetooth|Tailscale|ZeroTier/i

function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (!i || i.family !== 'IPv4' || i.internal) continue
      const rank = (VIRTUAL_ADAPTER.test(name) ? 100 : 0)
                 + (/Wi-?Fi|Wireless|WLAN/i.test(name) ? 0 : 10)
                 + (/^192\.168\./.test(i.address) ? 0 : /^10\./.test(i.address) ? 1 : 2)
      out.push({ name, ip: i.address, rank, virtual: VIRTUAL_ADAPTER.test(name) })
    }
  }
  return out.sort((a, b) => a.rank - b.rank)
}

const lanIPs = () => lanAddresses().map(a => a.ip)
const bestIP = () => lanAddresses()[0]?.ip ?? 'localhost'
const joinURL = () => 'https://' + bestIP() + ':' + CONFIG.port

// Chrome will only hand a page the camera on a secure origin, so plain http on a
// LAN IP is a dead end. Self-signed https + one "proceed anyway" per phone is the
// cheapest way through. The LAN IPs must be in the SAN or Chrome rejects it outright.
function tlsCert() {
  const keyFile = path.join(ROOT, 'certs', 'key.pem')
  const crtFile = path.join(ROOT, 'certs', 'cert.pem')
  const ips = lanIPs()
  if (fs.existsSync(keyFile) && fs.existsSync(crtFile)) {
    const cert = fs.readFileSync(crtFile, 'utf8')
    // A cert minted on another network has the wrong IPs in its SAN and Chrome
    // will refuse it outright, so re-mint when the machine has moved.
    const stale = ips.some(ip => !cert.includes(ip)) && !fs.existsSync(keyFile + '.pinned')
    if (!stale) return { key: fs.readFileSync(keyFile), cert }
    console.log('IP ของเครื่องเปลี่ยนไป - สร้าง certificate ใหม่')
  }

  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' },
                    ...ips.map(ip => ({ type: 7, ip }))]
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'kmitl-expo-print' }],
    { days: 365, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames }] })
  fs.writeFileSync(keyFile, pems.private)
  fs.writeFileSync(crtFile, pems.cert)
  return { key: pems.private, cert: pems.cert }
}

async function main() {
  if (!fs.existsSync(LOG))
    fs.writeFileSync(LOG, 'ticket,scanned_at,measured_at,state,health_score,error,device,url\n')

  if (CONFIG.dryRun) console.log('*** dryRun: จะ render แต่ไม่สั่งพิมพ์จริง ***')

  // A missing or renamed printer is now a warning, not a hard stop - the control
  // page can fix it without anyone editing a file or restarting.
  const names = await printer.list().then(l => l.map(p => p.name)).catch(() => [])
  if (!CONFIG.dryRun && (!CONFIG.printer || !names.includes(CONFIG.printer))) {
    console.warn('\n!! ยังไม่ได้เลือกเครื่องพิมพ์ที่ใช้ได้' +
                 (names.length ? '\n   ที่มีในเครื่อง: ' + names.join(' | ') : '') +
                 '\n   เลือกได้ที่หน้าควบคุม แล้วเริ่มพิมพ์ได้เลย ไม่ต้องปิดโปรแกรม\n')
  }

  console.log('เปิด Chromium สำหรับ render...')
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })

  sweepPrinter()
  setInterval(sweepPrinter, 5000)

  const server = https.createServer(tlsCert(), app)
  server.on('error', err => {
    if (err.code === 'EADDRINUSE')
      console.error('\n!! พอร์ต ' + CONFIG.port + ' ถูกใช้อยู่แล้ว' +
                    '\n   มี server ตัวเก่าเปิดค้างอยู่หรือเปล่า? ปิดหน้าต่างนั้นก่อน' +
                    '\n   หรือเปลี่ยนเลข "port" ใน config.json')
    else console.error('\n!! เปิด server ไม่ได้: ' + err.message)
    process.exit(1)
  })
  server.listen(CONFIG.port, async () => {
    console.log('\n  พร้อมใช้งาน\n')
    console.log('  หน้าควบคุม (เปิดบนโน้ตบุ๊ก):')
    console.log('     https://localhost:' + CONFIG.port + '/control.html\n')
    console.log('  หน้าสแกน (เปิดบนมือถือ staff):  ' + joinURL())
    for (const a of lanAddresses().slice(1))
      console.log('     สำรอง: https://' + a.ip + ':' + CONFIG.port + '   (' + a.name + ')')
    console.log('\n  สแกน QR นี้ด้วยมือถือเพื่อเปิดหน้าสแกนได้เลย:\n')
    console.log(await QRCode.toString(joinURL(), { type: 'terminal', small: true }))
    console.log('  ครั้งแรกมือถือจะเตือนเรื่อง https ให้กด "ขั้นสูง" -> "ดำเนินการต่อ"\n')
  })
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  console.log('\nกำลังปิด...')
  await browser?.close().catch(() => {})
  process.exit(0)
})

main()
