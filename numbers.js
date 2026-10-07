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

// 漢数字の前後に別の漢字が続くもの（「一回」「一旦」「三角」「十分」など）は数値として読まない
const OTHER_KANJI = /[\p{Script=Han}々]/u;
const NUMERAL_KANJI = /[〇零一二三四五六七八九十百千点]/;
function isWordPart(ch) { return !!ch && OTHER_KANJI.test(ch) && !NUMERAL_KANJI.test(ch); }

function normalizeSpokenNumbers(text) {
  let s = String(text ?? "").normalize("NFKC").replace(/てん|ポイント/g, "点").replace(/ゼロ/g, "〇");
  // 「三点〇一」: 点の前は位取り、点の後は1桁ずつ読む
  s = s.replace(/([〇零一二三四五六七八九十百千0-9]+)\s*点\s*([〇零一二三四五六七八九0-9]+)/g, (_, a, b) => `${kanjiInteger(a)}.${digitwise(b)}`);
  s = s.replace(/[〇零一二三四五六七八九十百千]+/g, (k, at, all) => isWordPart(all[at - 1]) || isWordPart(all[at + k.length]) ? " " : kanjiInteger(k));
  // 「1回」「1つ目」「2度」のような回数・順番は寸法ではないので除く
  s = s.replace(/(?<![\d.])\d+(?:\.\d+)?\s*(?:回|度|番|個|本|枚|人|つ|目|か所|箇所|ヶ所)/g, " ");
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

// 計測の合図（「はい」「OK」）の位置を返す。数がそろった後の合図で図形を追加するのに使う
const SIGNAL_RE = /(?<![A-Za-zＡ-Ｚａ-ｚ])[OoＯｏ][KkＫｋ](?![A-Za-zＡ-Ｚａ-ｚ])|オッケー?|オーケー|おっけー?|おーけー|はーい|はい|ハイ|ﾊｲ/g;
function findSignals(text) {
  return [...String(text ?? "").matchAll(SIGNAL_RE)].map(m => ({ index: m.index, end: m.index + m[0].length }));
}

if (typeof module !== "undefined") module.exports = { parseLengths, parseLength, normalizeSpokenNumbers, findSignals };
