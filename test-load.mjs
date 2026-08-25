// Fires synthetic scans at a running station. Run with dryRun:true in config.json.
//   node test-load.mjs [count]
// Each fake visitor is the sample payload with a different timestamp, so the
// dedupe path sees them as distinct people.

// Node's fetch has no per-request agent option, so the self-signed cert has to be
// waved through process-wide. Fine here - this file only ever talks to localhost.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BASE = 'https://127.0.0.1:8443'
const SAMPLE = 'TlEx8B5om3GSiUNT6vxYTj1eUXlaAEImYM5UJ9NVQVzC71X0kwVT2LnTP0gsK06/p5hLpBpPVUkK1UdAsCVEUYW7VNPXgE2ukT08Y6kOMUsYSVSwKgseHNE3Qk0KAABAzPVDJvMAPBsnQEmU6QBN9s6KV2AKcVP4wABLHQ5ARBW+Q0TKAwBDNYxJR0qmrVD4au9UE2bpL5i3MkJsnitAa5VkVPITcE/xTZVJ/wyWUNhPAEI='

// Offset every run so re-running against a still-live server does not collide
// with the payloads the previous run already registered as printed.
const RUN = Math.floor(Date.now() / 1000) % 100000 * 1000

function fakeVisitor(n) {
  const buf = Buffer.from(SAMPLE, 'base64')
  buf.writeUInt32LE(buf.readUInt32LE(3) + RUN + n, 3)   // nudge the timestamp
  return 'https://aqn.iamhtlife.com:8382/?r=' + encodeURIComponent(buf.toString('base64'))
}

const DEVICE = 'test-device-1'
const post = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device: DEVICE, ...(body ?? {}) }),
  }).then(async r => ({ status: r.status, body: await r.json() }))

const get = p => fetch(BASE + p).then(r => r.json())

const N = Number(process.argv[2] ?? 20)
let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  ' + detail : ''))
  ok ? pass++ : fail++
}

console.log('\n1) ปฏิเสธข้อมูลที่ไม่ใช่ QR ผลตรวจ')
const junk = await post('/api/print', { scanned: 'https://example.com/hello' })
check('ตอบ 422 พร้อมข้อความไทย', junk.status === 422 && /QR/.test(junk.body.error), junk.body.error)
const empty = await post('/api/print', { scanned: '' })
check('ตอบ 400 เมื่อไม่มีข้อมูล', empty.status === 400)

console.log('\n2) สแกนคนแรก แล้วสแกนซ้ำ')
const first = await post('/api/print', { scanned: fakeVisitor(0) })
check('รับคิวและได้เลขคิว', first.body.ok && !!first.body.ticket, 'คิว ' + first.body.ticket)
const again = await post('/api/print', { scanned: fakeVisitor(0) })
check('สแกนซ้ำไม่สร้างคิวใหม่',
      again.body.duplicate === true && again.body.ticket === first.body.ticket,
      'คืนคิวเดิม ' + again.body.ticket)

console.log('\n3) สั่งพิมพ์ซ้ำ')
const rp = await post('/api/reprint/' + first.body.ticket)
check('ได้คิวใหม่ที่อ้างอิงคิวเดิม', rp.body.ok && rp.body.reprintOf === first.body.ticket,
      rp.body.reprintOf + ' -> ' + rp.body.ticket)
const missing = await post('/api/reprint/999')
check('คิวที่ไม่มีตอบ 404', missing.status === 404)

console.log('\n4) ยกเลิกคิว')
const toCancel = await post('/api/print', { scanned: fakeVisitor(900) })
const cancelled = await post('/api/cancel/' + toCancel.body.ticket)
check('ยกเลิกคิวที่ยังไม่พิมพ์ได้', cancelled.body.ok === true, 'คิว ' + toCancel.body.ticket)
const cancelTwice = await post('/api/cancel/' + toCancel.body.ticket)
check('ยกเลิกซ้ำไม่ผ่าน', cancelTwice.status === 409 || cancelTwice.body.ok === false)
const cancelGhost = await post('/api/cancel/999')
check('ยกเลิกคิวที่ไม่มีตอบ 404', cancelGhost.status === 404)

console.log('\n5) สถานะมือถือที่เชื่อมต่อ')
await post('/api/hello', { name: 'เครื่องทดสอบ' })
const ctl = await get('/api/control')
check('นับเครื่องที่เชื่อมอยู่ได้', ctl.devices.length >= 1, ctl.devices.length + ' เครื่อง')
check('นับจำนวนสแกนของแต่ละเครื่อง', ctl.devices[0]?.scans >= 1, 'สแกน ' + ctl.devices[0]?.scans)

console.log('\n6) เครื่องพิมพ์')
const printers = await get('/api/printers')
check('อ่านรายชื่อเครื่องพิมพ์ได้', printers.ok && printers.printers.length > 0,
      printers.printers?.length + ' เครื่อง')
check('แยกเครื่องพิมพ์เสมือนออกได้', printers.printers.some(p => p.virtual))
check('อ่านสถานะเครื่องพิมพ์ได้', !!ctl.printer, ctl.printer?.status)
const badPrinter = await post('/api/config', { printer: 'เครื่องที่ไม่มีอยู่จริง' })
check('ปฏิเสธเครื่องพิมพ์ที่ไม่มี', badPrinter.body.ok === false, badPrinter.body.error)

console.log('\n7) งานที่พิมพ์ไม่สำเร็จ ต้องสแกนซ้ำได้')
// Reproduces the real failure: a virtual printer was selected, the job died, and
// rescanning that visitor's QR was then refused as a duplicate forever.
const before = await get('/api/control')
const realPrinter = before.config.printer
const virtualName = (await get('/api/printers')).printers.find(p => p.virtual)?.name

if (!virtualName) {
  check('มีเครื่องพิมพ์เสมือนให้ทดสอบ', false, 'ข้ามข้อนี้')
} else {
  await post('/api/config', { printer: virtualName, dryRun: false })
  const victim = fakeVisitor(700)
  const attempt = await post('/api/print', { scanned: victim })
  // wait for it to work through render -> print -> fail
  let st = await get('/api/control')
  for (let i = 0; i < 40 && !st.jobs.some(j => j.ticket === attempt.body.ticket && j.state === 'failed'); i++) {
    await new Promise(r => setTimeout(r, 400)); st = await get('/api/control')
  }
  const failed = st.jobs.find(j => j.ticket === attempt.body.ticket)
  check('เครื่องพิมพ์ลงไฟล์ทำให้งานล้ม (ตามที่ควร)', failed?.state === 'failed')
  check('ข้อความผิดพลาดอ่านรู้เรื่อง', !/SumatraPDF/i.test(failed?.error ?? ''), failed?.error?.slice(0, 60))

  const retry = await post('/api/print', { scanned: victim })
  check('สแกนซ้ำหลังพิมพ์ไม่สำเร็จ ได้คิวใหม่',
        retry.body.ok && !retry.body.duplicate && retry.body.ticket !== attempt.body.ticket,
        attempt.body.ticket + ' -> ' + retry.body.ticket)
  check('บอกว่าเป็นการลองใหม่ของคิวเดิม', retry.body.retryOf === attempt.body.ticket)

  await post('/api/config', { printer: realPrinter, dryRun: true })
  const cleaned = await get('/api/control')
  check('คืนค่าเครื่องพิมพ์เดิมได้', cleaned.config.printer === realPrinter)
}

console.log('\n8) ยิงรัว ' + N + ' คนพร้อมกัน')
// Measure deltas: step 7 deliberately left some failures behind.
const base = await get('/api/status')
const t0 = Date.now()
const burst = await Promise.all(Array.from({ length: N }, (_, i) => post('/api/print', { scanned: fakeVisitor(i + 1) })))
check('ทุกคนได้คิว', burst.every(r => r.body.ok && r.body.ticket))
check('เลขคิวไม่ซ้ำกัน', new Set(burst.map(r => r.body.ticket)).size === N)

let s = await get('/api/status')
while (s.queued > 0) { await new Promise(r => setTimeout(r, 400)); s = await get('/api/status') }
const secs = (Date.now() - t0) / 1000
check('คิวระบายหมด ไม่มีงานค้าง', s.queued === 0)
check('ไม่มีงานล้มระหว่างยิงรัว', s.failed === base.failed, 'ล้มเพิ่ม ' + (s.failed - base.failed))
// 1 คนแรก + 1 พิมพ์ซ้ำ + N ที่ยิงรัว - คิวต้องไม่ว่างจนกว่าใบสุดท้ายจะออกจริง
check('พิมพ์ครบ ' + N + ' ใบ (ตัวนับคิวไม่โกหก)', s.printed - base.printed === N, 'ได้ ' + (s.printed - base.printed))
check('งานที่ยกเลิกไม่ถูกพิมพ์', s.cancelled === base.cancelled, 'ยกเลิกรวม ' + s.cancelled + ' งาน')
console.log('     ใช้เวลา ' + secs.toFixed(1) + ' วิ  = ' + (secs / (N + 2)).toFixed(2) + ' วิ/ใบ (ยังไม่รวมเวลาพิมพ์จริง)')

console.log('\n' + (fail === 0 ? 'ผ่านทั้งหมด ' + pass + ' ข้อ' : 'ผ่าน ' + pass + ' / ไม่ผ่าน ' + fail))
process.exit(fail ? 1 : 0)
