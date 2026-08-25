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
// ConvertTo-Json, so decode the bits that a staff member can actually act on.
const JOB_FLAGS = [
  [0x0002, 'ผิดพลาด'], [0x0040, 'กระดาษหมด'], [0x0400, 'ต้องแก้ที่เครื่อง'],
  [0x0020, 'ออฟไลน์'], [0x0001, 'หยุดไว้'], [0x0004, 'กำลังยกเลิก'],
  [0x0010, 'กำลังพิมพ์'], [0x0008, 'กำลังส่ง'], [0x1000, 'เสร็จแล้ว'], [0x0080, 'พิมพ์แล้ว'],
]
const JOB_BAD = 0x0002 | 0x0040 | 0x0400 | 0x0020

function jobStatus(v) {
  if (typeof v === 'string' && v && !/^\d+$/.test(v)) return { text: v, bad: /error|paper|offline/i.test(v) }
  const n = Number(v) || 0
  const hits = JOB_FLAGS.filter(([bit]) => n & bit).map(([, th]) => th)
  return { text: hits.join(' · ') || 'รอคิว', bad: (n & JOB_BAD) !== 0 }
}

// Win32_Printer.PrinterStatus, mapped to something a staff member can act on.
const STATUS_TH = {
  1: 'ไม่ทราบสถานะ', 2: 'ไม่ทราบสถานะ', 3: 'พร้อมใช้งาน', 4: 'กำลังพิมพ์',
  5: 'กำลังอุ่นเครื่อง', 6: 'หยุดพิมพ์', 7: 'ออฟไลน์',
}

/** Every installed printer, with just enough state to pick one. */
export async function list() {
  const rows = await runJSON(
    'Get-Printer | Select-Object Name,PrinterStatus,DriverName,PortName')
  const wmi = await runJSON(
    'Get-CimInstance Win32_Printer | Select-Object Name,Default,WorkOffline,PrinterStatus')
  const byName = Object.fromEntries(wmi.map(w => [w.Name, w]))
  return rows.map(r => {
    const w = byName[r.Name] ?? {}
    return {
      name: r.Name,
      driver: r.DriverName,
      port: r.PortName,
      isDefault: !!w.Default,
      offline: !!w.WorkOffline,
      status: STATUS_TH[w.PrinterStatus] ?? 'ไม่ทราบสถานะ',
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
    `| Select-Object Name,WorkOffline,PrinterStatus,PrinterState,Default`)
  if (!info) return { name, found: false }

  const [port] = await runJSON(
    `Get-Printer -Name '${q(name)}' -ErrorAction SilentlyContinue | Select-Object PortName`)

  const jobs = await runJSON(
    `Get-PrintJob -PrinterName '${q(name)}' -ErrorAction SilentlyContinue ` +
    `| Select-Object Id,DocumentName,JobStatus,TotalPages,SubmittedTime`)

  // PRINTER_STATUS_PAUSED is bit 0 of PrinterState.
  const paused = (info.PrinterState & 1) === 1
  const virtual = /PORTPROMPT|nul:|FILE:/i.test(port?.PortName ?? '')
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
          : STATUS_TH[info.PrinterStatus] ?? 'ไม่ทราบสถานะ',
    ok: !info.WorkOffline && !paused && !virtual,
    jobs: jobs.map(j => {
      const st = jobStatus(j.JobStatus)
      return {
        id: j.Id,
        name: String(j.DocumentName ?? '').split('\\').pop(),
        status: st.text,
        bad: st.bad,
        pages: j.TotalPages ?? null,
      }
    }),
  }
}

export const pause = name => run(`(Get-CimInstance Win32_Printer -Filter "Name='${q(name)}'")` +
  ` | Invoke-CimMethod -MethodName Pause | Out-Null`)

export const resume = name => run(`(Get-CimInstance Win32_Printer -Filter "Name='${q(name)}'")` +
  ` | Invoke-CimMethod -MethodName Resume | Out-Null`)

export const cancelJob = (name, id) =>
  run(`Remove-PrintJob -PrinterName '${q(name)}' -ID ${Number(id)} -ErrorAction Stop`)

/** Clear a jammed queue - the usual fix when paper ran out mid-print. */
export const cancelAll = name =>
  run(`Get-PrintJob -PrinterName '${q(name)}' -ErrorAction SilentlyContinue` +
      ` | Remove-PrintJob -ErrorAction SilentlyContinue`)
