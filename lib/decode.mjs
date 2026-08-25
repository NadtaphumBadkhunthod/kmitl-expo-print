// Decoder for the NuraQR payload carried in the `?r=` query param.
//
// The QR is fully self-contained - it is NOT an id that has to be looked up on
// a server. Layout: "NQ1" magic | uint32 LE compact timestamp | N * 4-byte
// records of (crc16 of the point id, little-endian float16 value). So the whole
// print station works with the venue wifi unplugged.
//
// crc16 / the hash->string form are ports of the site's own results-app.js.

import { SECTIONS } from './points.mjs'

function crc16(s) {
  let crc = 0xFFFF
  for (const ch of s) {
    crc ^= ch.charCodeAt(0)
    for (let j = 0; j < 8; j++) {
      const odd = crc & 1
      crc >>= 1
      if (odd) crc ^= 0xA001
    }
  }
  return `${crc & 0xFF}${(crc >> 8) & 0xFF}`
}

function float16(lo, hi) {
  const u = lo | (hi << 8)
  const sign = u >> 15 ? -1 : 1
  const exp = (u >> 10) & 0x1f
  const frac = u & 0x3ff
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024)
  if (exp === 31) return frac ? NaN : sign * Infinity
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024)
}

// Every point we know how to render, plus the profile inputs the measurement
// carries along (age/height/weight/... are not in pointDefinitions).
const HASH_TO_ID = {}
for (const sec of SECTIONS) for (const p of sec.points) HASH_TO_ID[crc16(p.id)] = p.id
for (const id of ['INPUT_AGE', 'INPUT_HEIGHT', 'INPUT_WEIGHT', 'INPUT_GENDER',
                  'INPUT_DIABETES', 'INPUT_SMOKING', 'INPUT_BP_MEDICATION',
                  'SNR', 'STAR_RATING', 'BP_TAU', 'BMI']) HASH_TO_ID[crc16(id)] ??= id

/** Pull the `r` param out of a scanned string, which may be a full URL or the bare payload. */
export function extractPayload(scanned) {
  const s = String(scanned).trim()
  try {
    const u = new URL(s)
    const r = u.searchParams.get('r')
    if (r) return r
  } catch { /* not a URL - fall through and treat it as the payload itself */ }
  const m = s.match(/[?&]r=([^&\s]+)/)
  return m ? decodeURIComponent(m[1]) : s
}

export function decode(scanned) {
  const payload = extractPayload(scanned)
  const buf = Buffer.from(decodeURIComponent(payload), 'base64')

  if (buf.length < 7 || buf.subarray(0, 3).toString('latin1') !== 'NQ1')
    throw new Error('ไม่ใช่ QR ผลตรวจ (header ไม่ถูกต้อง)')
  if ((buf.length - 7) % 4 !== 0)
    throw new Error('ไม่ใช่ QR ผลตรวจ (ความยาว payload ไม่ถูกต้อง)')

  const t = String(buf.readUInt32LE(3)).padStart(10, '0')
  const measuredAt =
    `${t.slice(4, 6)}/${t.slice(2, 4)}/20${t.slice(0, 2)} ${t.slice(6, 8)}:${t.slice(8, 10)}`

  const values = {}
  for (let i = 7; i < buf.length; i += 4) {
    const id = HASH_TO_ID[`${buf[i]}${buf[i + 1]}`]
    if (id) values[id] = +float16(buf[i + 2], buf[i + 3]).toFixed(2)
  }

  if (Object.keys(values).length === 0) throw new Error('ถอดรหัสได้แต่ไม่พบค่าที่รู้จัก')
  return { measuredAt, values, payload }
}
