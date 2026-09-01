// The PIPEK A4 report layout: which points appear, in what order, in which
// column, and how each row is captioned.
//
// points.mjs supplies the numbers (bounds, scale segments) straight from the
// source site's data.js. This file supplies the presentation.

import { SECTIONS } from './points.mjs'

export const SCALES = Object.fromEntries(
  SECTIONS.flatMap(s => s.points).map(p => [p.id, p]))

/* ------------------------------------------------------------------ levels --- */

// Five levels, matching the colour bar printed on the report. The colours are
// the ones the PIPEK result page uses (sampled straight off its risk bar); the
// words are ours. PIPEK labels each band by direction - ปกติ / ต่ำ / ปานกลาง /
// ค่อนข้างสูง / สูง - which reads backwards on a sheet where some points are
// better high and some better low ("สูง" on sleep score is good news). These
// five say how the number is doing instead, so one ramp fits every row.
// `subTh`/`subEn` are the risk reading of the same band. They appear only in the
// legend, under the word - the two bands that mean "this needs attention" are
// the ones worth saying twice. The row verdicts stay one word: at 12.8px on a
// 354px column there is room for a judgement, not a sentence.
export const LEVELS = {
  good:    { th: 'ดี',          en: 'Good',      color: '#008609' },
  fair:    { th: 'ปานกลาง',    en: 'Fair',      color: '#7ba30f' },
  watch:   { th: 'เฝ้าระวัง',   en: 'Caution',   color: '#cfb000' },
  poor:    { th: 'ไม่ค่อยดี',   en: 'Poor',      color: '#ed7e2f',
             subTh: 'ค่อนข้างเสี่ยง', subEn: 'At risk' },
  bad:     { th: 'ไม่ดี',       en: 'Very poor', color: '#d71014',
             subTh: 'เสี่ยง',        subEn: 'High risk' },
  unknown: { th: '',           en: '',          color: '#8797ac' },
}

// The bar itself: five equal blocks, the exact colours of the on-screen bar.
// Only the second block differs from LEVELS - #90bd17 is fine as a 9px band but
// too pale for a bold number on white paper, so the text uses a darker green.
const BAR = ['#008609', '#90bd17', '#cfb000', '#ed7e2f', '#d71014']
const KEYS = ['good', 'fair', 'watch', 'poor', 'bad']

export const LEGEND = KEYS.map((k, i) =>
  ({ color: BAR[i], label: LEVELS[k].th, sub: LEVELS[k].subTh ?? '' }))

export const LEGEND_EN = KEYS.map((k, i) =>
  ({ color: BAR[i], label: LEVELS[k].en, sub: LEVELS[k].subEn ?? '' }))

/**
 * data.js only names four segment colours, and reuses "lightgreen" on BOTH sides
 * of the yellow band - e.g. sleep quality runs red, lightgreen, yellow,
 * lightgreen, green. So the colour name alone cannot tell "ปานกลาง" from
 * "ไม่ค่อยดี"; which side of the green segment it sits on can.
 */
export function levelOf(id, value) {
  const point = SCALES[id]
  if (!point || value === undefined || !point.segments.length) return 'unknown'

  const segs = [...point.segments].sort((a, b) => a.min - b.min)
  const at = segs.findIndex(s => value >= s.min && value < s.max)
  const i = at >= 0 ? at : (value < segs[0].min ? 0 : segs.length - 1)
  const seg = segs[i]

  if (seg.c === 'green') return 'good'
  if (seg.c === 'red') return 'bad'
  if (seg.c === 'yellow') return 'watch'

  const green = segs.findIndex(s => s.c === 'green')
  if (green < 0) return 'fair'
  return Math.abs(i - green) === 1 ? 'fair' : 'poor'
}

/* -------------------------------------------------------------------- rows --- */
// `en` is the caption under the Thai label - the English name plus whatever
// reference range is meaningful for that point.


const R = (id, th, en, unit = '', dp = 0) => ({ id, th, en, unit, dp })

export const COLUMNS = [
  [ // left
    { th: 'หัวใจและสัญญาณชีพ', en: 'HEART & VITALS', rows: [
      R('HR_BPM',             'อัตราการเต้นของหัวใจ',   'Pulse Rate · 60–100', 'bpm'),
      R('IHB_COUNT',          'การเต้นของหัวใจผิดปกติ', 'Irregular Heartbeats', 'ครั้ง'),
      R('BR_BPM',             'อัตราการหายใจ',          'Breathing Rate · 12–25', 'brpm'),
      { id: 'BP', th: 'ความดันโลหิต', en: 'Blood Pressure · <120 / <80', unit: 'mmHg',
        pair: ['BP_SYSTOLIC', 'BP_DIASTOLIC'] },
      R('TEMPERATURE_SENSOR', 'อุณหภูมิของร่างกาย',     'Body Temp · 36.5–37.5', '°C', 1),
    ] },
    { th: 'สรีระร่างกายและน้ำหนัก', en: 'BODY & WEIGHT', rows: [
      R('BMI_CALC',        'ดัชนีมวลกาย (BMI)',        'Body Mass Index · 19–25', 'kg/m²', 1),
      R('ABSI',            'ดัชนีรูปร่าง',              'Body Shape Index · ต่ำ=ดี', '', 2),
      R('WAIST_TO_HEIGHT', 'อัตราส่วนรอบเอวต่อส่วนสูง', 'Waist-to-Height · 43–53%', '%'),
      R('AGE',             'อายุผิวหน้า',               'Facial Skin Age · ประมาณการ', 'ปี'),
    ] },
    { th: 'ความเครียดและการนอนหลับ', en: 'STRESS & SLEEP', rows: [
      R('MSI',           'ดัชนีความเครียด',     'Mental Stress Index · 1–6 · ต่ำ=ดี', '', 1),
      R('SLEEP_QUALITY', 'คุณภาพการนอน',        'Sleep Quality Index · 1–6 · สูง=ดี', '', 1),
      R('ANXIETY_INDEX', 'ดัชนีความวิตกกังวล',   'Anxiety Index · 1–6 · ต่ำ=ดี', '', 1),
    ] },
  ],
  [ // right
    { th: 'สมรรถนะของร่างกาย', en: 'PHYSICAL PERFORMANCE', rows: [
      R('HRV_SDNN', 'ความแปรปรวนของการเต้นหัวใจ', 'Heart Rate Variability · สูง=ดี', 'ms', 1),
      R('BP_RPP',   'ภาระการทำงานของหัวใจ',       'Cardiac Workload · ต่ำ=ดี', 'dB', 2),
      R('VITALITY', 'ดัชนีสุขภาพและความมีชีวิตชีวา', 'Vitality Index · 1–6 · สูง=ดี', '', 1),
    ] },
    // The disease name alone in each row: the section heading already says
    // these are likelihoods, so repeating "ความเสี่ยง" 11 times only steals width.
    { th: 'ความเสี่ยงหัวใจและหลอดเลือด', en: 'GENERAL RISKS', rows: [
      R('BP_CVD',          'โรคหัวใจและหลอดเลือด', 'Cardiovascular Disease Risk · ต่ำ=ดี', '%'),
      R('BP_HEART_ATTACK', 'ภาวะหัวใจวาย',         'Heart Attack Risk · ต่ำ=ดี', '%'),
      R('BP_STROKE',       'โรคหลอดเลือดสมอง',     'Stroke Risk · ต่ำ=ดี', '%'),
    ] },
    { th: 'ความเสี่ยงด้านสุขภาพ', en: 'HEALTH RISKS', rows: [
      R('OVERALL_METABOLIC_RISK_PROB', 'โรคระบบเผาผลาญ',    'Overall Metabolic Risk · ต่ำ=ดี', '%'),
      R('HPT_RISK_PROB',   'โรคความดันโลหิตสูง',            'Hypertension Risk · ต่ำ=ดี', '%'),
      R('DBT_RISK_PROB',   'โรคเบาหวานประเภทที่ 2',         'Type 2 Diabetes Risk · ต่ำ=ดี', '%'),
      R('HDLTC_RISK_PROB', 'โรคไขมันในเลือดสูง',            'Hypercholesterolemia Risk · ต่ำ=ดี', '%'),
      R('TG_RISK_PROB',    'ภาวะไตรกลีเซอไรด์ในเลือดสูง',   'Hypertriglyceridemia Risk · ต่ำ=ดี', '%'),
      R('FLD_RISK_PROB',   'โรคไขมันพอกตับ',                'Fatty Liver Risk · ต่ำ=ดี', '%'),
      R('HBA1C_RISK_PROB', 'การสะสมของน้ำตาลในเลือด',       'Hemoglobin A1C Risk · ต่ำ=ดี', '%'),
      R('MFBG_RISK_PROB',  'ระดับน้ำตาลในเลือดสูง',         'Fasting Glucose Risk · ต่ำ=ดี', '%'),
    ] },
  ],
]

export const SUMMARY = [
  { id: 'VITAL_SCORE',    th: 'สัญญาณชีพ',   en: 'Vitals' },
  { id: 'PHYSIO_SCORE',   th: 'สมรรถนะกาย',  en: 'Physiological' },
  { id: 'MENTAL_SCORE',   th: 'ความเครียด',  en: 'Mental' },
  { id: 'PHYSICAL_SCORE', th: 'สรีระร่างกาย', en: 'Physical' },
  { id: 'RISKS_SCORE',    th: 'ความเสี่ยง',   en: 'Risks' },
]

const MONTHS_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "29/07/2026 21:44" from the decoder -> "29 ก.ค. 2026 · 21:44 น." */
export function thaiDate(measuredAt) {
  const m = measuredAt.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2})$/)
  if (!m) return measuredAt
  return `${+m[1]} ${MONTHS_TH[+m[2] - 1]} ${m[3]} · ${m[4]} น.`
}

export function enDate(measuredAt) {
  const m = measuredAt.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2})$/)
  if (!m) return measuredAt
  return `${+m[1]} ${MONTHS_EN[+m[2] - 1]} ${m[3]} · ${m[4]}`
}
