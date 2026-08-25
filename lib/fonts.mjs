// Sarabun, embedded.
//
// The reference PDF is typeset in Sarabun. Windows does not ship it, so without
// this the page silently falls back to Leelawadee UI - which is wider, and that
// is what pushed labels out of their boxes. Embedding the woff2 subsets as data
// URIs also means the booth never needs a font server or the internet.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')

export const FONT_CSS = (() => {
  let defs
  try {
    defs = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'))
  } catch {
    return ''   // fall back to system fonts rather than failing the print
  }
  return defs.map(d => {
    const b64 = fs.readFileSync(path.join(DIR, d.file)).toString('base64')
    return `@font-face{font-family:'Sarabun';font-style:normal;font-weight:${d.weight};` +
           `font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');` +
           `unicode-range:${d.range};}`
  }).join('\n')
})()

export const FONTS_EMBEDDED = FONT_CSS.length > 0
