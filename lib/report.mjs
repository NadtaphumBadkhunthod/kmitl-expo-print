// Builds the A4 report as HTML, reproducing รายงานผลคัดกรองสุขภาพ_PIPEK_A4.pdf.
//
// Every size and colour below was measured off that PDF rather than eyeballed:
// the page is laid out in A4-at-96dpi pixels (794 x 1123) so the numbers here are
// the same numbers the reference uses. @page margin is 0 and the margins live on
// body, so nothing gets re-flowed by the print pipeline.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLUMNS, SUMMARY, LEGEND, LEVELS, levelOf, thaiDate } from './layout.mjs'
import { FONT_CSS } from './fonts.mjs'

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')

// Both marks were lifted out of the reference PDF itself. Read once at load.
const logo = f => {
  try {
    return 'data:image/png;base64,' + fs.readFileSync(path.join(ASSETS, f)).toString('base64')
  } catch { return '' }
}
const KMITL_SEAL = logo('kmitl.png')
const SMC_LOGO = logo('smc.png')
const PIPEK_LOGO = logo('pipek.png')

/* ------------------------------------------------------------------ icons --- */
// The same line icons the result page puts above each figure, fetched from its
// assets/svg/<POINT_ID>.svg. Loaded once here and inlined, so a report never
// waits on the network.
//
// Two things have to be fixed on the way in. Ids inside one icon (clip paths,
// gradients) collide with the identical ids in the next once 26 of them share a
// document, so every id is namespaced. And the artwork is black: swapping that
// for currentColor lets each icon take its section's colour. Three of the icons
// are a PNG in an SVG wrapper and cannot be recoloured that way, so those are
// painted as a mask instead.
const ICONS = (() => {
  const out = {}
  let dir = []
  try { dir = fs.readdirSync(path.join(ASSETS, 'svg')) } catch { return out }
  for (const f of dir) {
    if (!f.endsWith('.svg')) continue
    const id = f.slice(0, -4)
    const raw = fs.readFileSync(path.join(ASSETS, 'svg', f), 'utf8')
    const bitmap = raw.match(/href="(data:image\/[a-z]+;base64,[^"]+)"/)
    if (bitmap) { out[id] = { mask: bitmap[1] }; continue }
    out[id] = { svg: raw
      .replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '')
      // strip width/height on the root only - the ones inside a clipPath's rect
      // are what makes the icon visible at all
      .replace(/<svg([^>]*)>/, (m, a) => '<svg' + a.replace(/\s(width|height)="[^"]*"/g, '') + '>')
      .replace(/id="([^"]+)"/g, (m, v) => `id="${id}_${v}"`)
      .replace(/url\(#([^)]+)\)/g, (m, v) => `url(#${id}_${v})`)
      .replace(/(fill|stroke)="(black|#1D1D1B)"/gi, '$1="currentColor"') }
  }
  return out
})()

function icon(id, color) {
  const ic = ICONS[id]
  if (!ic) return ''
  if (ic.mask)
    return `<span class="ic mask" style="background:${color};-webkit-mask-image:url(${ic.mask})"></span>`
  return `<span class="ic" style="color:${color}">${ic.svg}</span>`
}

// One colour for every section heading, its number badge and its row icons.
const HEAD_INK = '#204270'
const HEAD_TINT = '#e6edf7'

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const fmt = (v, dp) => v.toFixed(dp ?? 0)

const WORST = ['good', 'fair', 'watch', 'poor', 'bad']

/** One measurement: Thai name + value on top, English caption + verdict below. */
function row(r, values, hue) {
  // Systolic and diastolic share a line, and take the worse of the two verdicts.
  if (r.pair) {
    const [a, b] = r.pair.map(id => values[id])
    if (a === undefined || b === undefined) return ''
    const level = r.pair
      .map((id, i) => levelOf(id, [a, b][i]))
      .sort((x, y) => WORST.indexOf(y) - WORST.indexOf(x))[0]
    return line(r, `${fmt(a, 0)} / ${fmt(b, 0)}`, level, hue)
  }
  const v = values[r.id]
  if (v === undefined) return ''
  return line(r, fmt(v, r.dp), levelOf(r.id, v), hue)
}

function line(r, shown, level, hue) {
  const { color, th } = LEVELS[level] ?? LEVELS.unknown
  return `<div class="r" style="border-left-color:${color}">
    <div class="r1">${icon(r.id, hue)}<span class="nm">${esc(r.th)}</span>
      <span class="v" style="color:${color}">${esc(shown)}${
        r.unit ? `<small>${esc(r.unit)}</small>` : ''}</span></div>
    <div class="r2"><span class="en">${esc(r.en)}</span>
      <span class="j" style="color:${color}">${esc(th)}</span></div>
  </div>`
}

function block(sec, values, n) {
  const rows = sec.rows.map(r => row(r, values, HEAD_INK)).join('')
  if (!rows) return ''
  return `<section>
    <h2>
      <span class="n">${n}</span>
      <b>${esc(sec.th)}</b><i>${esc(sec.en)}</i></h2>
    <div class="rows">${rows}</div>
  </section>`
}

export function buildHTML({ ticket, measuredAt, values,
                            eventName, inkSaver = false, showTicket = true }) {
  // The same five-block bar the result page shows, with the labels centred under
  // their own block so a colour on a row can be read straight off it.
  const legend = `<section class="legend">
    <div class="lg-t">ระดับความเสี่ยงและความหมาย</div>
    <div class="lg-bar">${LEGEND.map(l => `<i style="background:${l.color}"></i>`).join('')}</div>
    <div class="lg-l">${LEGEND.map(l => `<span>${esc(l.label)}</span>`).join('')}</div>
  </section>`

  // The bar hangs under the left column: the right one carries the eleven risk
  // rows and is the taller of the two, so the spare height is all on the left.
  let seq = 0
  const columns = COLUMNS.map((col, n) =>
    `<div class="col">${col.map(sec => block(sec, values, ++seq)).join('')}${n === 0 ? legend : ''}</div>`
  ).join('')

  const summary = SUMMARY.map(s => {
    const v = values[s.id]
    const color = v === undefined ? LEVELS.unknown.color
      : (LEVELS[levelOf(s.id, v)] ?? LEVELS.unknown).color
    return `<div class="sc">
      <div class="sc-th">${esc(s.th)}</div>
      <div class="sc-en">${esc(s.en)}</div>
      <div class="sc-v" style="color:${color}">${
        v === undefined ? '—' : Math.round(v)}<small>/5</small></div>
    </div>`
  }).join('')

  const health = values.HEALTH_SCORE
  const healthColor = health === undefined ? LEVELS.unknown.color
    : (LEVELS[levelOf('HEALTH_SCORE', health)] ?? LEVELS.unknown).color

  const chip = (label, value, cls = '') =>
    `<div class="chip ${cls}"><span>${label}</span><b>${value}</b></div>`

  const stars = values.STAR_RATING === undefined ? '' : (() => {
    const n = Math.round(values.STAR_RATING)
    return `<span class="stars">${'★'.repeat(n)}<u>${'★'.repeat(Math.max(0, 5 - n))}</u></span>`
  })()

  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><style>
  ${FONT_CSS}
  /* Margins live on body so the layout is addressed in exact A4 pixels. */
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { width:794px; height:1123px; margin:0; padding:14px 38px 10px;
         font-family:'Sarabun','Leelawadee UI','Tahoma',sans-serif;
         font-size:14.7px; line-height:1.2; color:#3e4349;
         -webkit-print-color-adjust:exact; print-color-adjust:exact; }

  /* ------------------------------------------------------------ header --- */
  header { display:flex; align-items:center; gap:14px; min-height:74px;
           flex:none; padding-bottom:6px;
           border-bottom:2px solid #173a6a; }
  .marks { display:flex; align-items:center; gap:10px; flex:none; }
  .marks img { height:62px; }
  /* The seal is cropped tight to its rim, so it needs the breathing room the
     other two marks carry inside their own artwork. */
  .marks .seal { height:66px; margin-right:2px; }
  .brand { flex:1 1 auto; min-width:0; padding-left:2px; }
  .brand .b1 { font-size:25px; font-weight:800; color:#f16627; line-height:1.15; }
  .brand .b1 span { color:#173a6a; font-size:20px; font-weight:700; margin-left:7px; }
  .brand .b2 { font-size:18.7px; font-weight:700; color:#173a6a; line-height:1.3; }
  /* --------------------------------------------- measurement conditions --- */
  .meta { display:flex; gap:8px; min-height:38px; margin-top:6px; }
  /* flex-basis auto, not 0: with 0 every chip gets the same share and the
     widest caption is clipped while its neighbours sit half empty. */
  .chip { flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:9px;
          white-space:nowrap;
          padding:0 14px; background:#f5f7fa; border:1px solid #e6ebf2; border-radius:7px; }
  /* Four chips (the queue number is optional) can outgrow the row. The value must
     never be cut, so the caption is the part that gives way. */
  /* overflow:hidden clips the line box, and a Thai line box sized 1.2 loses the
     tails of ญ and the tone marks - hence the roomy line-height here. */
  .chip span { font-size:14.7px; color:#9ba3b0; min-width:0; line-height:1.75;
               overflow:hidden; text-overflow:ellipsis; }
  .chip b { flex:none; font-size:14.7px; font-weight:700; color:#173a6a; }
  .chip.tk { flex:0 0 auto; }
  .chip.tk b { font-size:18.7px; }
  /* .chip b would otherwise win on specificity and paint the stars navy. */
  .chip b .stars { letter-spacing:2px; color:#008609; font-size:15px; font-weight:400; }
  .stars u { color:#c9d2dd; text-decoration:none; }

  /* ----------------------------------------------------------- columns --- */
  main { display:flex; gap:10px; align-items:flex-start; margin-top:2px; }
  .col { flex:1 1 0; min-width:0; }
  /* The blocks used to sit flush against each other and read as one long list. */
  section { margin-bottom:8px; }
  section:last-child { margin-bottom:0; }

  h2 { display:flex; align-items:center; gap:7px; min-height:27px; margin:0; overflow:hidden;
       padding:0 10px; background:${HEAD_TINT}; border-radius:6px 6px 0 0; white-space:nowrap; }
  /* The section number, as on the result page. */
  h2 .n { flex:none; width:16px; height:16px; border-radius:50%; background:${HEAD_INK}; color:#fff;
          font-size:11.4px; font-weight:700; line-height:16px; text-align:center; }
  h2 b { font-size:14.7px; font-weight:700; color:${HEAD_INK}; flex:none; }
  h2 i { font-size:13.2px; font-style:normal; color:#98a2b3; letter-spacing:.1px;
         flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; }

  .rows { border:1px solid #e6ebf2; border-top:none; border-radius:0 0 6px 6px; overflow:hidden; }

  /* Row heights are driven by the text, never fixed. Thai stacks vowels and tone
     marks well above the x-height ("ไม่ดี", "เฝ้าระวัง"), so a line box sized for
     Latin lets those marks climb into the line above - which is exactly how the
     value and the verdict ended up printed on top of each other. */
  .r { padding:2px 12px 2px; border-left:4px solid #8797ac; border-bottom:1px solid #eef1f6; }
  .r:last-child { border-bottom:none; }
  .r1, .r2 { display:flex; align-items:baseline; gap:8px; line-height:1.32; }
  .r1 { gap:6px; }
  /* The icon rides on the first line and must not stretch it, so it is sized in
     px and pulled onto the text baseline rather than sitting in the flow. */
  .ic { flex:none; width:15px; height:15px; display:inline-block;
        align-self:center; margin-bottom:-3px; }
  .ic svg { width:15px; height:15px; display:block; }
  .ic.mask { -webkit-mask-size:contain; -webkit-mask-repeat:no-repeat;
             -webkit-mask-position:center; }
  .nm { font-size:13.4px; color:#3e4349; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
  .v { margin-left:auto; font-size:16.6px; font-weight:700; white-space:nowrap;
       font-variant-numeric:tabular-nums; }
  .v small { font-size:11.4px; font-weight:400; color:#909aa7; margin-left:3px; }
  .en { margin-left:21px; font-size:12.8px; color:#909aa7; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
  .j { margin-left:auto; font-size:12.8px; font-weight:700; white-space:nowrap; }

  /* --------------------------------------------------------- colour key -- */
  .legend { margin-top:4px; padding:5px 14px 7px;
            border:1px solid #e6ebf2; border-radius:6px; }
  .lg-t { font-size:13.4px; font-weight:700; color:#204270; line-height:1.3; }
  .lg-bar { display:flex; height:9px; margin-top:5px;
            border-radius:5px; overflow:hidden; }
  .lg-bar i { flex:1 1 0; }
  .lg-l { display:flex; margin-top:2px; }
  .lg-l span { flex:1 1 0; text-align:center; font-size:11.8px; color:#5b6675;
               line-height:1.35; }

  /* -------------------------------------------------------- score band --- */
  .score { margin-top:7px; background:#e6edf7; border:1px solid #e6ebf2; border-radius:7px; }
  .score-top { display:flex; align-items:center; min-height:50px; padding:4px 18px; }
  .score-top .t1 { font-size:15px; font-weight:700; color:#204270; line-height:1.3; }
  .score-top .t2 { font-size:13px; color:#8797ac; letter-spacing:.4px; line-height:1.25; }
  .score-top .tot { margin-left:auto; text-align:right; }
  .score-top .tot b { display:block; font-size:29px; font-weight:800; line-height:1.28; }
  .score-top .tot span { font-size:14.7px; color:#8797ac; }
  .scs { display:flex; background:#fff;
         border-top:1px solid #e6ebf2; border-radius:0 0 7px 7px; }
  .sc { flex:1 1 0; text-align:center; padding:3px 4px 4px; border-left:1px solid #eef1f6; }
  .sc:first-child { border-left:none; }
  .sc-th { font-size:13.4px; color:#3e4349; line-height:1.3; }
  .sc-en { font-size:12.8px; color:#909aa7; line-height:1.25; }
  .sc-v { font-size:17px; font-weight:700; line-height:1.3; }
  .sc-v small { font-size:12.8px; font-weight:400; color:#909aa7; }

  /* ------------------------------------------------------------ footer --- */
  .disc { margin-top:5px; padding:4px 13px; font-size:13px; line-height:1.32;
          background:#fbf6e9; border:1px solid #f0d184; border-radius:7px; color:#4a4230; }
  .disc b { color:#9a6a12; }
  /* A long event name could wrap this to a second line and push the whole
     report onto a second sheet, so it can only ever be one line. */
  .smc { margin-top:5px; padding:0 2px; font-size:13px; color:#8797ac;
         white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .smc b { color:#173a6a; font-weight:700; }

  /* Inkjets pay per drop: drop the large tinted panels, but keep every colour
     that carries meaning - the verdicts, the values, the risk bar, and the band
     behind each heading, which is what tells the sections apart at a glance. */
  body.ink .chip, body.ink .score, body.ink .disc { background:none; }
  </style></head><body class="${inkSaver ? 'ink' : ''}">

  <header>
    <div class="marks">
      ${KMITL_SEAL ? `<img class="seal" src="${KMITL_SEAL}" alt="">` : ''}
      ${SMC_LOGO ? `<img src="${SMC_LOGO}" alt="">` : ''}
      ${PIPEK_LOGO ? `<img src="${PIPEK_LOGO}" alt="">` : ''}
    </div>
    <div class="brand">
      <div class="b1">PIPEK<span>พิเภก</span></div>
      <div class="b2">รายงานผลการคัดกรองสุขภาพเบื้องต้น</div>
    </div>
  </header>

  <div class="meta">
    ${chip('วันที่ตรวจ', esc(thaiDate(measuredAt)))}
    ${values.SNR === undefined ? '' : chip('คุณภาพสัญญาณ', 'SNR ' + values.SNR.toFixed(1) + ' dB')}
    ${stars ? chip('ความน่าเชื่อถือ', stars) : ''}
    ${showTicket ? chip('คิว', esc(ticket), 'tk') : ''}
  </div>

  <main>${columns}</main>

  <div class="score">
    <div class="score-top">
      <div>
        <div class="t1">คะแนนสุขภาพโดยรวม</div>
        <div class="t2">GENERAL WELLNESS SCORE</div>
      </div>
      <div class="tot">
        <b style="color:${healthColor}">${health === undefined ? '—' : Math.round(health) + '%'}</b>
        <span>ประเมินโดยรวม</span>
      </div>
    </div>
    <div class="scs">${summary}</div>
  </div>

  <div class="disc">
    <b>&#9888; ข้อจำกัดความรับผิดชอบ:</b> ใช้เพื่อการรับรู้สุขภาพเบื้องต้นเท่านั้น
    <b>มิได้ใช้วินิจฉัย/รักษาโรค</b> หากสงสัยควรปรึกษาแพทย์;<br>Not a medical device.
  </div>
  <div class="smc"><b>SMC</b> — Smart City Research Center, KMITL;
    ติดต่อ: kmitlsmartcity2024@gmail.com${eventName ? '; ' + esc(eventName) : ''}</div>
  </body></html>`
}
