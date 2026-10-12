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

// 面積の単位（㎡・m²・平米・平方メートル）は数値の一部ではないので、NFKC で ㎡→m2 になる前に除く（「100㎡」を 100.02 と読まないように）
const AREA_UNIT_RE = /\s*(?:㎡|[mｍ]\s*²|平方メートル|平米)/g;

// 速く話すと、iPhone の音声入力は数の間に区切りを入れず「3.1 2.1 3.0」を「3.12.13.0」のようにつなげることがある。
// 小数点が2つ以上ある数は、つながった数とみなし、小数点以下を2桁まで（センチまで）として分ける。
//   3.12.13.0 → 3.1 2.1 3.0（点の間が2桁なら、1桁目が前の数の小数・2桁目が次の数の整数）
//   3.014.253 → 3.01 4.25 3（点の間が3桁以上なら、2桁が前の数の小数・残りが次の数の整数。最後も小数2桁より後ろは次の数）
// 点の間が1桁（「3.4.5」）は分け方が決められないので、そのままにする
function splitGluedDecimals(run) {
  const parts = run.split("."), out = [];
  let int = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (i === parts.length - 1) { out.push(`${int}.${seg.slice(0, 2)}`); if (seg.length > 2) out.push(seg.slice(2)); break; }
    if (seg.length < 2) return run;
    const dec = Math.min(2, seg.length - 1);
    out.push(`${int}.${seg.slice(0, dec)}`); int = seg.slice(dec);
  }
  return ` ${out.join(" ")} `;
}
// opts.splitGlued: つながった数を分ける（全画面の音声入力だけで使う）。分けたときは opts.glued = true にする
function normalizeSpokenNumbers(text, opts = {}) {
  let s = String(text ?? "").replace(AREA_UNIT_RE, " ").normalize("NFKC").replace(/てん|ポイント/g, "点").replace(/ゼロ/g, "〇");
  // 「三点〇一」: 点の前は位取り、点の後は1桁ずつ読む
  s = s.replace(/([〇零一二三四五六七八九十百千0-9]+)\s*点\s*([〇零一二三四五六七八九0-9]+)/g, (_, a, b) => `${kanjiInteger(a)}.${digitwise(b)}`);
  s = s.replace(/[〇零一二三四五六七八九十百千]+/g, (k, at, all) => isWordPart(all[at - 1]) || isWordPart(all[at + k.length]) ? " " : kanjiInteger(k));
  s = s.replace(/(?<=\d)点(?=\d)/g, "."); // 「3点12点13点0」のように続いた点も小数点にする（下でまとめて分ける）
  if (opts.splitGlued) s = s.replace(/(?<![\d.])\d+(?:\.\d+){2,}(?!\.?\d)/g, run => { const out = splitGluedDecimals(run); if (out !== run) opts.glued = true; return out; });
  // 「1回」「1つ目」「2度」のような回数・順番は寸法ではないので除く
  s = s.replace(/(?<![\d.])\d+(?:\.\d+)?\s*(?:回|度|番|個|本|枚|人|つ|目|か所|箇所|ヶ所)/g, " ");
  // 「3メートル5センチ」→ 3.05（センチと言ったときは、後ろの数値をセンチとして扱う）
  s = s.replace(/(?<![\d.])(\d+)\s*(?:メートル|m)\s*(\d{1,2})\s*(?:センチメートル|センチ|cm)/gi, (_, m, cm) => `${Number(m) + Number(cm) / 100} `); // 後ろの空白は食べない（「4m25 3.01」が 4.253 にならないように）
  // 「4m25」「1メートル05」→ 4.25 / 1.05、「1メートル5」→ 1.5（m の後ろの数字は小数点以下として読む）
  // 1桁は m に続けて書いたときだけ（「3m 4 5」の 4 は次の寸法）。2桁は「4m 25」のような空白があっても読む
  s = s.replace(/(?<![\d.])(\d+)\s*(?:メートル|m)(?:(\d)|\s*(\d{2}))(?![\d.])(?!\s*(?:メートル|m|センチメートル|センチ|cm))/gi, (_, m, d1, d2) => `${d1 !== undefined ? Number(m) + Number(d1) / 10 : Number(m) + Number(d2) / 100} `);
  // 変換した値の前には空白を入れない（「-50cm」の負号が数値から離れて、正の数として読まれないように）。「.5cm」も 0.005 と読む
  s = s.replace(/(?<![\d.])(\d+(?:\.\d+)?|\.\d+)\s*(?:センチメートル|センチ|cm)/gi, (_, cm) => `${Number(cm) / 100} `);
  return s;
}

// 「.5」は 0.5 と読む。先頭や空白の後の「-」「−」は負の数として返し、寸法の検査で弾く（「3-4-5」のような区切りの「-」はそのまま区切り）
// 「- 3」のように負号と数値の間に空白があっても負の数とする（正の 3 として追加しないように）
function parseLengths(text, opts) {
  const s = normalizeSpokenNumbers(text, opts), values = [];
  for (const m of s.matchAll(/(?<![\d.])(?:\d+(?:\.\d+)?|\.\d+)/g)) {
    const negative = /(?:^|[\s、,(（])[-−]\s*$/.test(s.slice(0, m.index));
    values.push((negative ? -1 : 1) * Number(m[0]));
  }
  return values.filter(Number.isFinite);
}

function parseLength(text) {
  const values = parseLengths(text);
  return values.length ? values[0] : NaN;
}

// 設計面積の欄: 「100m2」も面積の単位として読む（寸法の「4m25」とは違い、面積の欄では m の後ろの 2 はセンチではない）
// 「百㎡」のような漢数字でも読めるよう、㎡・m² は NFKC の前に除き、m2 は直前が数字でなくても除く
// 「1,200」「1，200.5」の桁区切りのカンマは除く（寸法の欄と違い、面積の欄に数を並べることはないので、区切りとして読まない）
function parseArea(text) {
  return parseLength(String(text ?? "").replace(AREA_UNIT_RE, " ").normalize("NFKC").replace(/\s*m\s*2(?!\d)/gi, " ").replace(/(?<=\d),(?=\d{3}(?!\d))/g, ""));
}

// 計測の合図（「はい」「OK」）の位置を返す。数がそろった後の合図で図形を追加するのに使う
// 「これはいい」「ハイライト」のように、後ろにかなが続く「はい」「ハイ」は言葉の一部なので合図にしない（「はいっ」は合図）
const SIGNAL_RE = /(?<![A-Za-zＡ-Ｚａ-ｚ])[OoＯｏ][KkＫｋ](?![A-Za-zＡ-Ｚａ-ｚ])|オッケー?|オーケー|おっけー?|おーけー|(?:はーい|はい|ハイ|ﾊｲ)(?!(?![っッｯ])[ぁ-ゖァ-ヺｦ-ﾝ])/g;
function findSignals(text) {
  return [...String(text ?? "").matchAll(SIGNAL_RE)].map(m => ({ index: m.index, end: m.index + m[0].length }));
}

if (typeof module !== "undefined") module.exports = { parseLengths, parseLength, parseArea, normalizeSpokenNumbers, findSignals };
