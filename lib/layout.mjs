// The PIPEK A4 report layout: which points appear, in what order, in which
// column, and how each row is captioned.
//
// points.mjs supplies the numbers (bounds, scale segments) straight from the
// source site's data.js. This file supplies the presentation.

import { SECTIONS } from './points.mjs'

export const SCALES = Object.fromEntries(
  SECTIONS.flatMap(s => s.points).map(p => [p.id, p]))

/* ------------------------------------------------------------------ levels --- */

// Five verdicts, matching the colour legend printed on the report.
// Sampled from the legend swatches of the reference PDF, not guessed.
export const LEVELS = {
  good:    { th: 'ดี',       color: '#159a52' },
  fair:    { th: 'ปานกลาง',  color: '#7cb342' },
  watch:   { th: 'เฝ้าระวัง', color: '#e0a100' },
  poor:    { th: 'ไม่ค่อยดี', color: '#f2889b' },
  bad:     { th: 'ไม่ดี',     color: '#e5484d' },
  unknown: { th: '',         color: '#8797ac' },
}

export const LEGEND = [
  [['good', 'ดี'], ['fair', 'ปานกลาง'], ['watch', 'เฝ้าระวัง']],
  [['poor', 'ไม่ค่อยดี / ค่อนข้างเสี่ยง'], ['bad', 'ไม่ดี / เสี่ยง']],
]

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
    { th: 'สัญญาณชีพ', en: 'VITALS', rows: [
      R('HR_BPM',             'อัตราการเต้นของหัวใจ', 'Pulse Rate · 60–100', 'bpm'),
      R('IHB_COUNT',          'จังหวะเต้นผิดปกติ',    'Irregular Heartbeats', 'ครั้ง'),
      R('BR_BPM',             'อัตราการหายใจ',        'Breathing Rate · 12–25', 'brpm'),
      { id: 'BP', th: 'ความดันโลหิต', en: 'Blood Pressure · <120 / <80', unit: 'mmHg',
        pair: ['BP_SYSTOLIC', 'BP_DIASTOLIC'] },
      R('TEMPERATURE_SENSOR', 'อุณหภูมิร่างกาย',      'Body Temp · 36.5–37.5', '°C', 1),
    ] },
    { th: 'สรีรวิทยา', en: 'PHYSIOLOGICAL', rows: [
      R('HRV_SDNN', 'ความแปรปรวนหัวใจ (HRV)',   'Heart Rate Variability · สูง=ดี', 'ms', 1),
      R('BP_RPP',   'ภาระงานของหัวใจ',           'Cardiac Workload · ต่ำ=ดี', 'dB', 2),
      R('VITALITY', 'ดัชนีความกระปรี้กระเปร่า',   'Vitality Index · 1–6 · สูง=ดี', '', 1),
    ] },
    { th: 'สุขภาพจิต', en: 'MENTAL', rows: [
      R('MSI',           'ดัชนีความเครียด',    'Mental Stress Index · 1–6 · ต่ำ=ดี', '', 1),
      R('SLEEP_QUALITY', 'ดัชนีคุณภาพการนอน',  'Sleep Quality Index · 1–6 · สูง=ดี', '', 1),
      R('ANXIETY_INDEX', 'ดัชนีความวิตกกังวล',  'Anxiety Index · 1–6 · ต่ำ=ดี', '', 1),
    ] },
    { th: 'ตัวชี้วัดในเลือด', en: 'BLOOD BIOMARKERS', rows: [
      R('HBA1C_RISK_PROB', 'ความเสี่ยงน้ำตาลสะสม (HbA1C)', 'Hemoglobin A1C Likelihood', '%'),
      R('MFBG_RISK_PROB',  'ความเสี่ยงน้ำตาลขณะอดอาหาร',   'Fasting Glucose Likelihood', '%'),
    ] },
  ],
  [ // right
    { th: 'สุขภาพกาย', en: 'PHYSICAL', rows: [
      R('AGE',             'อายุผิวหน้า',        'Facial Skin Age · ประมาณการ', 'ปี'),
      R('BMI_CALC',        'ดัชนีมวลกาย (BMI)',  'Body Mass Index · 19–25', 'kg/m²', 1),
      R('ABSI',            'ดัชนีรูปร่าง',        'Body Shape Index · ต่ำ=ดี', '', 2),
      R('WAIST_TO_HEIGHT', 'รอบเอวต่อส่วนสูง',    'Waist-to-Height · 43–53%', '%'),
    ] },
    { th: 'ความเสี่ยงทั่วไป', en: 'GENERAL LIKELIHOOD', rows: [
      R('BP_CVD',          'หัวใจและหลอดเลือด',   'Cardiovascular', '%'),
      R('BP_HEART_ATTACK', 'ภาวะหัวใจวาย',        'Heart Attack', '%'),
      R('BP_STROKE',       'หลอดเลือดสมอง',       'Stroke', '%'),
    ] },
    { th: 'ความเสี่ยงทางเมแทบอลิก', en: 'METABOLIC LIKELIHOOD', rows: [
      R('OVERALL_METABOLIC_RISK_PROB', 'เมแทบอลิกโดยรวม', 'Overall Metabolic', '%'),
      R('HPT_RISK_PROB',   'ความดันโลหิตสูง',     'Hypertension', '%'),
      R('DBT_RISK_PROB',   'เบาหวานชนิดที่ 2',    'Type 2 Diabetes', '%'),
      R('HDLTC_RISK_PROB', 'คอเลสเตอรอลสูง',      'Hypercholesterolemia', '%'),
      R('TG_RISK_PROB',    'ไตรกลีเซอไรด์สูง',    'Hypertriglyceridemia', '%'),
      R('FLD_RISK_PROB',   'ไขมันพอกตับ',         'Fatty Liver', '%'),
    ] },
  ],
]

export const SUMMARY = [
  { id: 'VITAL_SCORE',    th: 'สัญญาณชีพ', en: 'Vitals' },
  { id: 'PHYSIO_SCORE',   th: 'สรีรวิทยา',  en: 'Physiological' },
  { id: 'MENTAL_SCORE',   th: 'สุขภาพจิต',  en: 'Mental' },
  { id: 'PHYSICAL_SCORE', th: 'สุขภาพกาย',  en: 'Physical' },
  { id: 'RISKS_SCORE',    th: 'ความเสี่ยง',  en: 'Risks' },
]

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

/** "29/07/2026 21:44" from the decoder -> "29 ก.ค. 2026 · 21:44 น." */
export function thaiDate(measuredAt) {
  const m = measuredAt.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2})$/)
  if (!m) return measuredAt
  return `${+m[1]} ${MONTHS[+m[2] - 1]} ${m[3]} · ${m[4]} น.`
}
