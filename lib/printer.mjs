// Windows printer control, over the PrintManagement cmdlets.
//
// Everything here shells out to powershell.exe. That is slower than a native
// binding but needs nothing installed, and these calls only run when the control
// page asks for them - never on the path that prints a visitor's report.

import { execFile } from 'node:child_process'

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

function run(script, { timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [...PS, script],
      { timeout, windowsHide: true, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        if (err && !stdout.trim()) return reject(new Error((stderr || err.message).trim().split('\n')[0]))
        resolve(stdout.trim())
      })
  })
}

/** Run a script that ends in ConvertTo-Json and always get an array back. */
async function runJSON(script) {
  const out = await run(script + ' | ConvertTo-Json -Depth 3 -Compress')
  if (!out) return []
  try {
    const v = JSON.parse(out)
    return Array.isArray(v) ? v : [v]
  } catch {
    return []
  }
}

const q = s => String(s).replace(/'/g, "''")   // single-quote escaping for PowerShell

// Get-PrintJob hands JobStatus back as a numeric flag field once it crosses
// ConvertTo-Json, and Windows sets several bits at once: a job the spooler has
// finished with but cannot let go of reads 4108 = Complete + Spooling + Deleting.
// Listing all three said "กำลังยกเลิก · กำลังส่ง · เสร็จแล้ว", which is noise.
// One label, most urgent first, and the rest is dropped.
const JOB_FLAGS = [
  [0x0400, 'ต้องแก้ที่เครื่อง'], [0x0040, 'กระดาษหมด'], [0x0002, 'ผิดพลาด'],
  [0x0020, 'ออฟไลน์'], [0x0004, 'ค้างอยู่ในคิว Windows'], [0x0001, 'หยุดไว้'],
  [0x0010, 'กำลังพิมพ์'], [0x0008, 'กำลังส่ง'], [0x0080, 'พิมพ์แล้ว'], [0x1000, 'เสร็จแล้ว'],
]
const JOB_BAD = 0x0002 | 0x0040 | 0x0400 | 0x0020
const JOB_DELETING = 0x0004

function jobStatus(v) {
  if (typeof v === 'string' && v && !/^\d+$/.test(v)) return { text: v, bad: /error|paper|offline/i.test(v) }
  const n = Number(v) || 0
  const hit = JOB_FLAGS.find(([bit]) => n & bit)
  return {
    text: hit ? hit[1] : 'รอคิว',
    bad: (n & JOB_BAD) !== 0,
    // Windows accepts the delete, marks the job Deleting, and then leaves it
    // sitting there. Only a spooler restart shifts it.
    stuck: (n & JOB_DELETING) !== 0,
  }
}

// Win32_Printer.PrinterStatus, mapped to something a staff member can act on.
const STATUS_TH = {
  1: null, 2: null, 3: 'พร้อมใช้งาน', 4: 'กำลังพิมพ์',
  5: 'กำลังอุ่นเครื่อง', 6: 'หยุดพิมพ์', 7: 'ออฟไลน์',
}

// Plenty of network printers report PrinterStatus 1 ("Other") while perfectly
// idle - the HP Smart Tank at the booth does. DetectedErrorState is the field
// that actually knows, so fall back to it instead of shrugging.
const ERROR_TH = {
  3: 'กระดาษใกล้หมด', 4: 'กระดาษหมด', 5: 'หมึกใกล้หมด', 6: 'หมึกหมด',
  7: 'ฝาเปิดอยู่', 8: 'กระดาษติด', 9: 'ออฟไลน์', 10: 'ต้องแก้ที่เครื่อง',
  11: 'ถาดรับกระดาษเต็ม',
}

function stateText(info) {
  const err = ERROR_TH[info.DetectedErrorState]
  if (err) return { text: err, ok: false }
  const st = STATUS_TH[info.PrinterStatus]
  if (st) return { text: st, ok: info.PrinterStatus === 3 || info.PrinterStatus === 4 }
  // DetectedErrorState 2 is "No Error"; anything else here is genuinely unknown.
  return info.DetectedErrorState === 2
    ? { text: 'พร้อมใช้งาน', ok: true }
    : { text: 'ไม่ทราบสถานะ', ok: true }
}

/** Every installed printer, with just enough state to pick one. */
export async function list() {
  const rows = await runJSON(
    'Get-Printer | Select-Object Name,PrinterStatus,DriverName,PortName')
  const wmi = await runJSON(
    'Get-CimInstance Win32_Printer' +
    ' | Select-Object Name,Default,WorkOffline,PrinterStatus,DetectedErrorState')
  const byName = Object.fromEntries(wmi.map(w => [w.Name, w]))
  return rows.map(r => {
    const w = byName[r.Name] ?? {}
    return {
      name: r.Name,
      driver: r.DriverName,
      port: r.PortName,
      isDefault: !!w.Default,
      offline: !!w.WorkOffline,
      status: w.WorkOffline ? 'ออฟไลน์' : stateText(w).text,
      // "Print to PDF" style targets can't produce paper; flag them so the
      // control page can warn instead of silently printing into a file dialog.
      virtual: /PORTPROMPT|nul:|FILE:/i.test(r.PortName ?? ''),
    }
  })
}

/** Live state of one printer plus whatever is sitting in its Windows queue. */
export async function status(name) {
  if (!name) return { name: null, found: false }
  const [info] = await runJSON(
    `Get-CimInstance Win32_Printer -Filter "Name='${q(name)}'" ` +
    `| Select-Object Name,WorkOffline,PrinterStatus,PrinterState,DetectedErrorState,Default`)
  if (!info) return { name, found: false }

  const [port] = await runJSON(
    `Get-Printer -Name '${q(name)}' -ErrorAction SilentlyContinue | Select-Object PortName`)

  const jobs = await runJSON(
    `Get-PrintJob -PrinterName '${q(name)}' -ErrorAction SilentlyContinue ` +
    `| Select-Object Id,DocumentName,JobStatus,TotalPages,SubmittedTime`)

  // PRINTER_STATUS_PAUSED is bit 0 of PrinterState.
  const paused = (info.PrinterState & 1) === 1
  const virtual = /PORTPROMPT|nul:|FILE:/i.test(port?.PortName ?? '')
  const live = stateText(info)
  const decoded = jobs.map(j => ({ j, st: jobStatus(j.JobStatus) }))
  return {
    name,
    found: true,
    offline: !!info.WorkOffline,
    paused,
    virtual,
    port: port?.PortName ?? null,
    isDefault: !!info.Default,
    status: virtual ? 'พิมพ์ลงไฟล์ ไม่ออกกระดาษ'
          : paused ? 'หยุดพิมพ์ชั่วคราว'
          : info.WorkOffline ? 'ออฟไลน์'
          : live.text,
    ok: !info.WorkOffline && !paused && !virtual && live.ok,
    // One job Windows will not let go of blocks everything queued behind it,
    // so the page needs to know without reading every row.
    stuck: decoded.some(d => d.st.stuck),
    jobs: decoded.map(({ j, st }) => ({
      id: j.Id,
      name: String(j.DocumentName ?? '').split('\\').pop(),
      status: st.text,
      bad: st.bad || st.stuck,
      stuck: st.stuck,
      pages: j.TotalPages ?? null,
    })),
  }
}

export const pause = name => run(`(Get-CimInstance Win32_Printer -Filter "Name='${q(name)}'")` +
  ` | Invoke-CimMethod -MethodName Pause | Out-Null`)

export const resume = name => run(`(Get-CimInstance Win32_Printer -Filter "Name='${q(name)}'")` +
  ` | Invoke-CimMethod -MethodName Resume | Out-Null`)

/**
 * Delete one job out of the Windows queue. Returns 'ok', 'gone' or 'stuck'.
 *
 * Two ways this used to look like a dead button. Remove-PrintJob throws when the
 * job has already left the queue - that is the outcome the staff member wanted,
 * so it counts as done. And when the printer is unreachable, Remove-PrintJob
 * *succeeds*, Windows marks the job Deleting, and then leaves it in the list
 * forever: the click did everything right and the row never moved. So check
 * afterwards, and say so.
 */
export async function cancelJob(name, id) {
  const n = Number(id)
  if (!Number.isInteger(n)) throw new Error('เลขงานไม่ถูกต้อง')
  const out = await run(
    `$p = '${q(name)}'; ` +
    `if (-not (Get-PrintJob -PrinterName $p -ID ${n} -ErrorAction SilentlyContinue)) { 'gone'; exit }; ` +
    `try { Remove-PrintJob -PrinterName $p -ID ${n} -ErrorAction Stop } ` +
    `catch { 'err:' + $_.Exception.Message; exit }; ` +
    `Start-Sleep -Milliseconds 700; ` +
    `$after = Get-PrintJob -PrinterName $p -ID ${n} -ErrorAction SilentlyContinue; ` +
    `if ($after) { 'stuck' } else { 'ok' }`)
  if (out.startsWith('err:')) {
    const msg = out.slice(4).trim()
    throw new Error(/Access is denied|ถูกปฏิเสธ/i.test(msg)
      ? 'ไม่มีสิทธิ์ลบงานนี้ — งานของผู้ใช้อื่น ต้องเปิด Windows ในสิทธิ์ผู้ดูแล'
      : msg.split(String.fromCharCode(10))[0])
  }
  return out === 'gone' ? 'gone' : out === 'stuck' ? 'stuck' : 'ok'
}

/**
 * Restart the Windows print spooler - the only thing that shifts a job stuck in
 * Deleting, and it empties every queue on the machine.
 *
 * Stopping a service needs elevation, which the station is not running with, so
 * fall back to asking Windows for it. That puts a UAC box on the laptop screen
 * for someone to confirm; the promise resolves as soon as it is on screen, not
 * when the restart finishes.
 */
export async function restartSpooler() {
  const direct = await run(
    `try { Restart-Service -Name Spooler -Force -ErrorAction Stop; 'ok' } catch { 'no' }`,
    { timeout: 30000 })
  if (direct === 'ok') return 'ok'
  await run(`Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList ` +
            `'-NoProfile','-Command','Restart-Service -Name Spooler -Force'`)
  return 'uac'
}

/** Clear a jammed queue - the usual fix when paper ran out mid-print. */
export const cancelAll = name =>
  run(`Get-PrintJob -PrinterName '${q(name)}' -ErrorAction SilentlyContinue` +
      ` | Remove-PrintJob -ErrorAction SilentlyContinue`)
