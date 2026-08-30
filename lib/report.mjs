// Builds the A4 report as HTML, reproducing รายงานผลคัดกรองสุขภาพ_PIPEK_A4.pdf.
//
// Every size and colour below was measured off that PDF rather than eyeballed:
// the page is laid out in A4-at-96dpi pixels (794 x 1123) so the numbers here are
// the same numbers the reference uses. @page margin is 0 and the margins live on
// body, so nothing gets re-flowed by the print pipeline.

import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { fileURLToPath } from 'node:url'
import { COLUMNS, SUMMARY, LEGEND, LEGEND_EN, LEVELS, levelOf, thaiDate, enDate } from './layout.mjs'
import { FONT_CSS } from './fonts.mjs'

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')

// The three marks, read once at load. Each is carried as a CSS rule rather than
// an <img src>, so a two-language sheet embeds the artwork once instead of once
// per page - the marks are by far the heaviest thing on the sheet.
//
// Each mark is carried twice, in colour and in grey: black-and-white mode has to
// work even if the printer driver ignores the monochrome flag, and a picture the
// driver converts on the way out still costs colour ink on some drivers.
/** Flatten a PNG to greys, keeping its alpha. */
function grey(png) {
  for (let i = 0; i < png.data.length; i += 4) {
    // Quantised to 32 levels, the same posterising the colour artwork already
    // carries: invisible on a 62px mark, and it keeps the grey copy from
    // costing more bytes than the colour one it replaces.
    const y = Math.round(0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2])
    png.data[i] = png.data[i + 1] = png.data[i + 2] = y & 0xf8
  }
  return png
}

const logo = (cls, f, h, mono) => {
  try {
    let bytes = fs.readFileSync(path.join(ASSETS, f))
    const png = PNG.sync.read(bytes)
    if (mono) bytes = PNG.sync.write(grey(png),
      { deflateLevel: 9, deflateStrategy: 3, filterType: -1 })
    return `.marks .${cls}{height:${h}px;aspect-ratio:${png.width}/${png.height};` +
           `background-image:url(data:image/png;base64,${bytes.toString('base64')})}`
  } catch { return '' }
}
// Prefixed: a bare .smc here would also match the footer line and pick up its
// margin, and both preview.mjs and check-fit.mjs measure the page by .smc.
const marks = mono => [
  logo('m-seal', 'kmitl.png', 66, mono),
  logo('m-smc', 'smc.png', 62, mono),
  logo('m-pipek', 'pipek.png', 62, mono),
].join('\n  ')
const MARK_CSS = { colour: marks(false), mono: marks(true) }

// One colour for every section heading, its number badge and its row icons.
const HEAD_INK = '#204270'
const HEAD_TINT = '#e6edf7'

// Black and white, for the day the colour tanks run dry. The five risk colours
// have to survive as greys, and a luminance conversion will not do it: #008609
// and #d71014 land within a few levels of each other, so "ปกติ" and "สูง" would
// print the same. This ramp goes light to dark as the risk rises, and keeps the
// text dark enough to read at 13px whatever the level.
const MONO_INK = '#333333'
const MONO_TINT = '#ededed'
const MONO = {
  good:    { bar: '#c6c6c6', ink: '#5c5c5c' },
  fair:    { bar: '#a5a5a5', ink: '#525252' },
  watch:   { bar: '#828282', ink: '#3d3d3d' },
  poor:    { bar: '#5c5c5c', ink: '#242424' },
  bad:     { bar: '#2b2b2b', ink: '#000000' },
  unknown: { bar: '#c6c6c6', ink: '#6b6b6b' },
}
const LEVEL_ORDER = ['good', 'fair', 'watch', 'poor', 'bad']

/* ------------------------------------------------------------------ icons --- */
// The same line icons the result page puts above each figure, fetched from its
// assets/svg/<POINT_ID>.svg. Loaded once here and inlined, so a report never
// waits on the network.
//
// Two things have to be fixed on the way in. Ids inside one icon (clip paths,
// gradients) collide with the identical ids in the next once 26 of them share a
// document, so every id is namespaced. And the artwork is black: swapping that
// for currentColor lets each icon take the heading colour.
//
// Three of the icons are a transparent PNG in an SVG wrapper. currentColor does
// nothing to a bitmap, and painting them as a CSS mask - which looks right on
// screen - printed as three solid squares, because the print pipeline drops the
// mask and leaves the background it was masking. So their pixels are recoloured
// here instead: keep the alpha, replace the black with the ink colour.
/** Repaint a transparent PNG in one colour, keeping its alpha channel. */
function tint(base64, hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const png = PNG.sync.read(Buffer.from(base64, 'base64'))
  for (let i = 0; i < png.data.length; i += 4) {
    if (!png.data[i + 3]) continue
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b
  }
  return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64')
}

/**
 * Trim the artwork to what a 15px icon can show. The exports carry five and six
 * decimal places, but the whole icon is 15px wide over a 128-unit viewBox - one
 * unit is already a tenth of a pixel, so everything past the first decimal is
 * bytes the printer cannot resolve. Roughly a third of the file, on the largest
 * icons more than half.
 */
function minifySVG(s) {
  return s
    .replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sd="([^"]+)"/g, (m, d) =>
      ' d="' + d.replace(/-?\d+\.\d+/g, n => String(+(+n).toFixed(1))) + '"')
    .replace(/\s*\n\s*/g, ' ').replace(/>\s+</g, '><')
    .trim()
}

const ICONS = (() => {
  const out = {}
  let dir = []
  try { dir = fs.readdirSync(path.join(ASSETS, 'svg')) } catch { return out }
  for (const f of dir) {
    if (!f.endsWith('.svg')) continue
    const id = f.slice(0, -4)
    const raw = fs.readFileSync(path.join(ASSETS, 'svg', f), 'utf8')
    const bitmap = raw.match(/href="data:image\/png;base64,([^"]+)"/)
    if (bitmap) {
      out[id] = { img: tint(bitmap[1], HEAD_INK), imgMono: tint(bitmap[1], MONO_INK) }
      continue
    }
    // Each icon becomes a <symbol> carried once at the top of the document and
    // drawn with <use>, so a two-language sheet costs one copy of the artwork
    // rather than one per page.
    out[id] = { symbol: minifySVG(raw)
      .replace(/id="([^"]+)"/g, (m, v) => `id="${id}_${v}"`)
      .replace(/url\(#([^)]+)\)/g, (m, v) => `url(#${id}_${v})`)
      .replace(/(fill|stroke)="(black|#1D1D1B)"/gi, '$1="currentColor"')
      // width/height go on the root only - the ones inside a clipPath's rect are
      // what makes the icon visible at all.
      .replace(/^<svg([^>]*)>/, (m, a) =>
        `<symbol id="ic_${id}"` + a.replace(/\s(width|height|xmlns(:\w+)?)="[^"]*"/g, '') + '>')
      .replace(/<\/svg>$/, '</symbol>') }
  }
  return out
})()

const SPRITE = `<svg class="sprite" aria-hidden="true">${
  Object.values(ICONS).map(i => i.symbol ?? '').join('')}</svg>`

function icon(id, color, mono) {
  const ic = ICONS[id]
  if (!ic) return ''
  if (ic.img) return `<img class="ic" src="${mono ? ic.imgMono : ic.img}" alt="">`
  return `<svg class="ic" style="color:${color}"><use href="#ic_${id}"/></svg>`
}

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const fmt = (v, dp) => v.toFixed(dp ?? 0)

const WORST = ['good', 'fair', 'watch', 'poor', 'bad']

function buildPage({ ticket, measuredAt, values, eventName, inkSaver = false, showTicket = true, lang = 'TH', mono = false }) {
  const isEn = lang === 'ENG'
  // In colour, one value per level does both jobs. In grey the bar and the text
  // need different shades: a bar dark enough to rank has to be too dark to read
  // 13px type on, and text light enough to sit under a number is too pale a bar.
  const hue = mono ? MONO_INK : HEAD_INK
  const barOf = k => mono ? (MONO[k] ?? MONO.unknown).bar : (LEVELS[k] ?? LEVELS.unknown).color
  const inkOf = k => mono ? (MONO[k] ?? MONO.unknown).ink : (LEVELS[k] ?? LEVELS.unknown).color
  const currentLegend = isEn ? LEGEND_EN : LEGEND
  const legend = `<section class="legend">
    <div class="lg-t">${isEn ? 'Risk Level & Meaning' : 'ระดับความเสี่ยงและความหมาย'}</div>
    <div class="lg-bar">${currentLegend.map((l, i) =>
      `<i style="background:${mono ? MONO[LEVEL_ORDER[i]].bar : l.color}"></i>`).join('')}</div>
    <div class="lg-l">${currentLegend.map(l => `<span>${esc(l.label)}</span>`).join('')}</div>
  </section>`

  const tTitle = (sec) => isEn ? sec.en : sec.th
  const tSub = (sec) => isEn ? '' : sec.en

  const buildRow = (r, values, hue) => {
    if (r.pair) {
      const [a, b] = r.pair.map(id => values[id])
      if (a === undefined || b === undefined) return ''
      const level = r.pair
        .map((id, i) => levelOf(id, [a, b][i]))
        .sort((x, y) => WORST.indexOf(y) - WORST.indexOf(x))[0]
      return buildLine(r, `${fmt(a, 0)} / ${fmt(b, 0)}`, level, hue)
    }
    const v = values[r.id]
    if (v === undefined) return ''
    return buildLine(r, fmt(v, r.dp), levelOf(r.id, v), hue)
  }

  const buildLine = (r, shown, level, hue) => {
    const { th, en } = LEVELS[level] ?? LEVELS.unknown
    const bar = barOf(level)
    const color = inkOf(level)
    const verdict = isEn ? en : th
    const titleText = isEn ? r.en.split(' · ')[0] : r.th
    let subText = isEn ? (r.en.includes(' · ') ? r.en.split(' · ').slice(1).join(' · ') : '') : r.en
    
    let unitText = r.unit
    if (isEn) {
      if (unitText === 'ครั้ง') unitText = 'times'
      if (unitText === 'ปี') unitText = 'years'
      
      subText = subText.replace('สูง=ดี', 'High = Good')
                       .replace('ต่ำ=ดี', 'Low = Good')
                       .replace('ประมาณการ', 'Estimated')
    }

    return `<div class="r" style="border-left-color:${bar}">
      <div class="r1">${icon(r.id, hue, mono)}<span class="nm">${esc(titleText)}</span>
        <span class="v" style="color:${color}">${esc(shown)}${
          unitText ? `<small>${esc(unitText)}</small>` : ''}</span></div>
      <div class="r2"><span class="en">${esc(subText)}</span>
        <span class="j" style="color:${color}">${esc(verdict)}</span></div>
    </div>`
  }

  const buildBlock = (sec, values, n) => {
    const rows = sec.rows.map(r => buildRow(r, values, hue)).join('')
    if (!rows) return ''
    return `<section>
      <h2>
        <span class="n">${n}</span>
        <b>${esc(tTitle(sec))}</b><i>${esc(tSub(sec))}</i></h2>
      <div class="rows">${rows}</div>
    </section>`
  }

  let seq = 0
  const columns = COLUMNS.map((col, n) =>
    `<div class="col">${col.map(sec => buildBlock(sec, values, ++seq)).join('')}${n === 0 ? legend : ''}</div>`
  ).join('')

  const summary = SUMMARY.map(s => {
    const v = values[s.id]
    const color = inkOf(v === undefined ? 'unknown' : levelOf(s.id, v))
    return `<div class="sc">
      <div class="sc-th">${esc(tTitle(s))}</div>
      <div class="sc-en">${esc(tSub(s))}</div>
      <div class="sc-v" style="color:${color}">${
        v === undefined ? '—' : Math.round(v)}<small>/5</small></div>
    </div>`
  }).join('')

  const health = values.HEALTH_SCORE
  const healthColor = inkOf(health === undefined ? 'unknown' : levelOf('HEALTH_SCORE', health))

  const chip = (label, value, cls = '') =>
    `<div class="chip ${cls}"><span>${label}</span><b>${value}</b></div>`

  const stars = values.STAR_RATING === undefined ? '' : (() => {
    const n = Math.round(values.STAR_RATING)
    return `<span class="stars">${'★'.repeat(n)}<u>${'★'.repeat(Math.max(0, 5 - n))}</u></span>`
  })()

  const dateStr = isEn ? enDate(measuredAt) : thaiDate(measuredAt)
  const dateLabel = isEn ? 'Date' : 'วันที่ตรวจ'
  const snrLabel = isEn ? 'Signal Quality' : 'คุณภาพสัญญาณ'
  const relLabel = isEn ? 'Measurement Quality' : 'คุณภาพการตรวจ'
  const tkLabel = isEn ? 'Queue' : 'คิว'

  return `
  <div class="page-container">
    <header>
      <div class="marks">
        <i class="m-seal"></i><i class="m-pipek"></i><i class="m-smc"></i>
      </div>
    </header>

    <div class="meta">
      ${chip(dateLabel, esc(dateStr))}
      ${values.SNR === undefined ? '' : chip(snrLabel, 'SNR ' + values.SNR.toFixed(1) + ' dB')}
      ${stars ? chip(relLabel, stars) : ''}
      ${showTicket ? chip(tkLabel, esc(ticket), 'tk') : ''}
    </div>

    <main>${columns}</main>

    <div class="score">
      <div class="score-top">
        <div>
          <div class="t1">${isEn ? 'GENERAL WELLNESS SCORE' : 'คะแนนสุขภาพโดยรวม'}</div>
          <div class="t2">${isEn ? '' : 'GENERAL WELLNESS SCORE'}</div>
        </div>
        <div class="tot">
          <b style="color:${healthColor}">${health === undefined ? '—' : Math.round(health) + '%'}</b>
          <span>${isEn ? 'Overall Estimate' : 'ประเมินโดยรวม'}</span>
        </div>
      </div>
      <div class="scs">${summary}</div>
    </div>

    <div class="disc">
      <b>&#9888; ${isEn ? 'Disclaimer:' : 'ข้อจำกัดความรับผิดชอบ:'}</b> ${isEn ? 'For preliminary health awareness only.' : 'ใช้เพื่อการรับรู้สุขภาพเบื้องต้นเท่านั้น'}
      <b>${isEn ? 'Not for diagnosis/treatment.' : 'มิได้ใช้วินิจฉัย/รักษาโรค'}</b> ${isEn ? 'Consult a doctor if in doubt.' : 'หากสงสัยควรปรึกษาแพทย์;'}<br><b class="nd">${isEn ? 'Not a medical device.' : 'ไม่ใช่เครื่องมือทางการแพทย์'}</b>
    </div>
    <div class="smc"><b>SMC</b> - Smart City Research Center<br>
      School of Engineering KMITL<br>
      ${isEn ? 'Contact:' : 'ติดต่อ:'} kmitlsmartcity2024@gmail.com${
        eventName ? '<br>' + esc(eventName) : ''}</div>
  </div>`
}

export function buildHTML(opts) {
  const lang = opts.lang || 'TH'
  const mono = !!opts.mono
  const pages = []
  if (lang === 'BOTH' || lang === 'TH') {
    pages.push(buildPage({ ...opts, mono, lang: 'TH' }))
  }
  if (lang === 'BOTH' || lang === 'ENG') {
    pages.push(buildPage({ ...opts, mono, lang: 'ENG' }))
  }

  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><style>
  ${FONT_CSS}
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }

  /* The neutrals - text, hairlines, panel fills. Named here because black and
     white mode has to replace every one of them: they read as grey on screen but
     they are all faintly blue (#e6ebf2 is 230,235,242), and a faintly blue line
     still asks an inkjet for cyan. The grey below each one carries the same
     brightness, so the sheet looks identical and costs no colour ink. */
  :root { --ink:#3e4349; --mute:#909aa7; --faint:#8797ac; --line:#e6ebf2;
          --hair:#eef1f6; --chip-l:#9ba3b0; --star-off:#c9d2dd; --sub:#98a2b3;
          --leg:#5b6675; --disc-ink:#4a4230; --chip-bg:#f5f7fa; }
  body.mono { --ink:#434343; --mute:#9a9a9a; --faint:#979797; --line:#ebebeb;
              --hair:#f1f1f1; --chip-l:#a3a3a3; --star-off:#d2d2d2; --sub:#a2a2a2;
              --leg:#666666; --disc-ink:#444444; --chip-bg:#f7f7f7; }
  body { margin:0; font-family:'Sarabun','Leelawadee UI','Tahoma',sans-serif;
         font-size:14.7px; line-height:1.2; color:var(--ink);
         -webkit-print-color-adjust:exact; print-color-adjust:exact; }

  .page-container { width:794px; height:1123px; padding:14px 38px 10px; position:relative; overflow:hidden; page-break-after:always; }
  .page-container:last-child { page-break-after:auto; }

  /* ------------------------------------------------------------ header --- */
  header { display:flex; align-items:center; justify-content:center; gap:14px;
           min-height:66px; flex:none; padding-bottom:6px;
           border-bottom:2px solid #173a6a; }
  .marks { display:flex; align-items:center; gap:10px; flex:none; }
  .marks i { flex:none; background-repeat:no-repeat; background-position:center;
             background-size:contain; }
  /* The seal is cropped tight to its rim, so it needs the breathing room the
     other two marks carry inside their own artwork. */
  .marks .m-seal { margin-right:2px; }
  ${mono ? MARK_CSS.mono : MARK_CSS.colour}
  /* --------------------------------------------- measurement conditions --- */
  .meta { display:flex; gap:8px; min-height:38px; margin-top:6px; }
  .chip { flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:9px;
          white-space:nowrap;
          padding:0 14px; background:var(--chip-bg); border:1px solid var(--line); border-radius:7px; }
  .chip span { font-size:14.7px; color:var(--chip-l); min-width:0; line-height:1.75;
               overflow:hidden; text-overflow:ellipsis; }
  .chip b { flex:none; font-size:14.7px; font-weight:700; color:#173a6a; }
  .chip.tk { flex:0 0 auto; }
  .chip.tk b { font-size:18.7px; }
  .chip b .stars { letter-spacing:2px; color:#008609; font-size:15px; font-weight:400; }
  .stars u { color:var(--star-off); text-decoration:none; }

  /* ----------------------------------------------------------- columns --- */
  main { display:flex; gap:10px; align-items:flex-start; margin-top:2px; }
  .col { flex:1 1 0; min-width:0; }
  section { margin-bottom:8px; }
  section:last-child { margin-bottom:0; }

  h2 { display:flex; align-items:center; gap:7px; min-height:27px; margin:0; overflow:hidden;
       padding:0 10px; background:${HEAD_TINT}; border-radius:6px 6px 0 0; white-space:nowrap; }
  h2 .n { flex:none; width:16px; height:16px; border-radius:50%; background:${HEAD_INK}; color:#fff;
          font-size:11.4px; font-weight:700; line-height:16px; text-align:center; }
  h2 b { font-size:14.7px; font-weight:700; color:${HEAD_INK}; flex:none; }
  h2 i { font-size:13.2px; font-style:normal; color:var(--sub); letter-spacing:.1px;
         flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; }

  .rows { border:1px solid var(--line); border-top:none; border-radius:0 0 6px 6px; overflow:hidden; }

  .r { padding:2px 12px 2px; border-left:4px solid var(--faint); border-bottom:1px solid var(--hair); }
  .r:last-child { border-bottom:none; }
  .r1, .r2 { display:flex; align-items:baseline; gap:8px; line-height:1.32; }
  .r1 { gap:6px; }
  .ic { flex:none; width:15px; height:15px; display:inline-block;
        align-self:center; margin-bottom:-3px; }
  .sprite { position:absolute; width:0; height:0; overflow:hidden; }
  img.ic { object-fit:contain; }
  .nm { font-size:13.4px; color:var(--ink); overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; padding:3px 0; margin:-3px 0; }
  .v { margin-left:auto; font-size:16.6px; font-weight:700; white-space:nowrap;
       font-variant-numeric:tabular-nums; }
  .v small { font-size:11.4px; font-weight:400; color:var(--mute); margin-left:3px; }
  .en { margin-left:21px; font-size:12.8px; color:var(--mute); overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; padding:3px 0; margin:-3px 0; }
  .j { margin-left:auto; font-size:12.8px; font-weight:700; white-space:nowrap; }

  /* --------------------------------------------------------- colour key -- */
  .legend { margin-top:4px; padding:5px 14px 7px;
            border:1px solid var(--line); border-radius:6px; }
  .lg-t { font-size:13.4px; font-weight:700; color:#204270; line-height:1.3; }
  .lg-bar { display:flex; height:9px; margin-top:5px;
            border-radius:5px; overflow:hidden; }
  .lg-bar i { flex:1 1 0; }
  .lg-l { display:flex; margin-top:2px; }
  .lg-l span { flex:1 1 0; text-align:center; font-size:11.8px; color:var(--leg);
               line-height:1.35; padding-top:2px; }

  /* -------------------------------------------------------- score band --- */
  .score { margin-top:6px; background:#e6edf7; border:1px solid var(--line); border-radius:7px; }
  .score-top { display:flex; align-items:center; min-height:50px; padding:4px 18px; }
  .score-top .t1 { font-size:15px; font-weight:700; color:#204270; line-height:1.3; }
  .score-top .t2 { font-size:13px; color:var(--faint); letter-spacing:.4px; line-height:1.25; }
  .score-top .tot { margin-left:auto; text-align:right; }
  .score-top .tot b { display:block; font-size:29px; font-weight:800; line-height:1.28; }
  .score-top .tot span { font-size:14.7px; color:var(--faint); }
  .scs { display:flex; background:#fff;
         border-top:1px solid var(--line); border-radius:0 0 7px 7px; }
  .sc { flex:1 1 0; text-align:center; padding:3px 4px 4px; border-left:1px solid var(--hair); }
  .sc:first-child { border-left:none; }
  .sc-th { font-size:13.4px; color:var(--ink); line-height:1.3; }
  .sc-en { font-size:12.8px; color:var(--mute); line-height:1.25; }
  .sc-v { font-size:17px; font-weight:700; line-height:1.3; }
  .sc-v small { font-size:12.8px; font-weight:400; color:var(--mute); }

  /* ------------------------------------------------------------ footer --- */
  .disc { margin-top:5px; padding:4px 13px; font-size:13px; line-height:1.32;
          background:#fbf6e9; border:1px solid #f0d184; border-radius:7px; color:var(--disc-ink); }
  .disc b { color:#9a6a12; }
  /* The one line nobody may skim past. */
  .disc .nd { color:#d71014; }
  .smc { margin-top:4px; padding:0 2px 2px; font-size:12.2px; line-height:1.3;
         color:var(--faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .smc b { color:#173a6a; font-weight:700; }

  /* --------------------------------------------------- black and white --- */
  /* Everything the risk palette does not reach: the marks, the headings, the
     panels. Written out rather than filtered, because a CSS filter on the page
     is one more thing the print pipeline can quietly drop.
     Ahead of body.ink on purpose - both blocks set .score/.disc backgrounds at
     the same weight, and with both modes on it is ink saver that has to win. */
  body.mono header { border-bottom-color:#333333; }
  body.mono .chip b, body.mono .smc b, body.mono h2 b,
  body.mono .lg-t, body.mono .score-top .t1 { color:${MONO_INK}; }
  body.mono .chip b .stars { color:#444444; }
  body.mono h2 { background:${MONO_TINT}; }
  body.mono h2 .n { background:#4a4a4a; }
  body.mono .score { background:${MONO_TINT}; }
  body.mono .disc { background:#f4f4f4; border-color:#d0d0d0; }
  body.mono .disc b { color:#333333; }
  /* Still the line nobody may skim past - in grey it carries by weight. */
  body.mono .disc .nd { color:#000000; }

  body.ink .chip, body.ink .score, body.ink .disc { background:none; }
  </style></head><body class="${opts.inkSaver ? 'ink ' : ''}${mono ? 'mono' : ''}">
  ${SPRITE}${pages.join('')}
  </body></html>`
}
