"use strict";
// 音声入力・手入力の文字列から距離（m）を取り出す。
// 例: "3.01 4.25 3" / "3点01、4点25、3" / "三点〇一 四点二五 三" / "3メートル1センチ" / "4m25"
const KANJI_DIGITS = { "〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
const KANJI_UNITS = { "十": 10, "百": 100, "千": 1000 };

function digitwise(text) {
  return [...text].map(ch => (ch in KANJI_DIGITS ? KANJI_DIGITS[ch] : ch)).join("");
}

function kanjiInteger(text) {
  if (!/[十百千]/.test(text)) return digitwise(text);
  let total = 0, current = 0;
  for (const ch of text) {
    if (ch in KANJI_UNITS) { total += (current || 1) * KANJI_UNITS[ch]; current = 0; }
    else current = Number(digitwise(ch));
  }
  return String(total + current);
}

function normalizeSpokenNumbers(text) {
  let s = String(text ?? "").normalize("NFKC").replace(/てん|ポイント/g, "点");
  // 「三点〇一」: 点の前は位取り、点の後は1桁ずつ読む
  s = s.replace(/([〇零一二三四五六七八九十百千0-9]+)\s*点\s*([〇零一二三四五六七八九0-9]+)/g, (_, a, b) => `${kanjiInteger(a)}.${digitwise(b)}`);
  s = s.replace(/[〇零一二三四五六七八九十百千]+/g, kanjiInteger);
  // 「3メートル5センチ」「4m25」→ 3.05 / 4.25（後ろの数値はセンチとして扱う）
  s = s.replace(/(?<![\d.])(\d+)\s*(?:メートル|m)\s*(\d{1,2})(?![\d.])(?!\s*(?:メートル|m))\s*(?:センチメートル|センチ|cm)?/gi, (_, m, cm) => String(Number(m) + Number(cm) / 100));
  s = s.replace(/(?<![\d.])(\d+(?:\.\d+)?)\s*(?:センチメートル|センチ|cm)/gi, (_, cm) => ` ${Number(cm) / 100} `);
  return s;
}

function parseLengths(text) {
  return (normalizeSpokenNumbers(text).match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
}

function parseLength(text) {
  const values = parseLengths(text);
  return values.length ? values[0] : NaN;
}

if (typeof module !== "undefined") module.exports = { parseLengths, parseLength, normalizeSpokenNumbers };
