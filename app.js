"use strict";
const STORAGE_KEY = "field-area-drawings-v2", SETTINGS_KEY = "field-area-settings-v1";
const THIN_ANGLE_DEG = 20; // これより小さい角を持つ三角形は警告する
const CLOSE_RADIUS = 0.15; // 新しい頂点が既存の頂点からこの距離（m）以内なら、その頂点に閉じる（v13.2）
const CLOSE_WARN = 0.05;   // 閉じたときのずれ（閉合差）がこれ（m）を超えたら、寸法の確認を促す
const DEFAULT_SETTINGS = { digits: 3, method: "round", sumMode: "total", outdoor: false, wakeLock: true, measureKeyboard: "voice", projectCollapsed: false, signalAdd: true, showRaw: false, measureZoom: true };
const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const state = { mode: "triangle", shapes: [], selectedEdge: null, recordId: null, editingId: null, candidate: null, records: loadRecords(), settings: loadSettings(), confirmAction: null, autoError: "", deferredInstall: null, viewBox: "0 0 700 430", savedSnapshot: "", zoom: { key: null, points: [] }, recordBase: null, draftFailed: false, wakeLock: null, wakeLockPending: false, signal: { needs: [], added: 0, barrier: null }, lastQuick: "", voiceLog: [], selected: new Set() };
const FIELD_LABELS = { sideA: "a", sideB: "b", sideC: "c", topBase: "上底", bottomBase: "下底", height: "高さ" };
const DIMENSION_FIELDS = Object.keys(FIELD_LABELS);
const mobileDevice = /Android|iPad|iPhone|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 0;

// ---------- 共通 ----------
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function esc(v) { return String(v ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function num(id) { return parseLength($(id).value); }
function designNum() { return parseArea($("designArea").value); } // 設計面積は「100m2」「100㎡」も 100 と読む
function fmtLen(v) { return String(Number(Number(v).toFixed(3))); }
// 面積の丸め方。保存した記録は保存時の丸め方（record.rounding）で表示・出力し、後から設定を変えても値が変わらないようにする
const LEGACY_ROUNDING = { digits: 3, method: "round", sumMode: "total" }; // 丸め方を持たない旧記録（v10 まで）の表示方法
function currentRounding() { const { digits, method, sumMode } = state.settings; return { digits, method, sumMode }; }
function recordRounding(record) { return record?.rounding || LEGACY_ROUNDING; }
function fmt(v, digits = state.settings.digits) { return Number(v).toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function roundArea(v, ro = state.settings) {
  const f = 10 ** ro.digits, x = Number(v) * f;
  const r = ro.method === "floor" ? Math.floor(x + 1e-7) : ro.method === "ceil" ? Math.ceil(x - 1e-7) : Math.round(x + 1e-7);
  return r / f;
}
function computeTotal(shapes, ro = state.settings) {
  if (ro.sumMode === "each") return Number(shapes.reduce((s, v) => s + roundArea(v.area, ro), 0).toFixed(ro.digits));
  return roundArea(shapes.reduce((s, v) => s + Number(v.area), 0), ro);
}
function roundingText(ro = state.settings) {
  return `小数第${ro.digits}位・${{ round: "四捨五入", floor: "切り捨て", ceil: "切り上げ" }[ro.method]}・${ro.sumMode === "each" ? "図形ごとに丸めて合計" : "合計してから丸め"}`;
}
function roundingNote(ro = state.settings) { return `面積の丸め：${roundingText(ro)}`; }
// 差は表示の桁数で丸める。比率は丸める前の差から出す（小さい面積で、丸めた差が 0 になっても比率は残るように）
function designDiff(total, design, digits = state.settings.digits) {
  if (!(design > 0)) return null;
  const raw = total - design;
  return { diff: Number(raw.toFixed(digits)) || 0, ratio: raw / design * 100 };
}
function diffText(total, design, digits = state.settings.digits) {
  const d = designDiff(total, design, digits); if (!d) return "";
  const sign = v => v > 0 ? "+" : v < 0 ? "−" : "±", ratio = Number(d.ratio.toFixed(2)) || 0;
  return `${sign(d.diff)}${fmt(Math.abs(d.diff), digits)} m²（${sign(ratio)}${Math.abs(ratio).toFixed(2)}%）`;
}

// ---------- 幾何 ----------
function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function samePoint(a, b, tol = 1e-6) { return dist(a, b) < tol; }
function sameEdge(a, b, c, d) { return (samePoint(a, c) && samePoint(b, d)) || (samePoint(a, d) && samePoint(b, c)); }
function signedArea(points) { let s = 0; for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; s += a.x * b.y - b.x * a.y; } return s / 2; }
function polygonArea(points) { return Math.abs(signedArea(points)); }
function centroid(points) { return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length }; }
function alignment() { return document.querySelector('input[name="alignment"]:checked').value; }
function edgeOf(shape, index) { return { shapeId: shape.id, index, a: shape.points[index], b: shape.points[(index + 1) % shape.points.length] }; }
function shapeEdges(shape) { return shape.points.map((_, i) => edgeOf(shape, i)); }
function edgeKey(e) { return `${e.shapeId}:${e.index}`; }
// 外周の辺: ほかの図形と共有していない辺。v13.9: 辺の途中からつないだ図形の底辺は、親の辺の中に収まっている（内側の辺）ので外周に含めない。
// 親の辺は、つないでいない残りの部分があるので外周に残す
function onSegment(p, a, b, tol = 1e-6) {
  const L = dist(a, b); if (L < tol) return false;
  const cross = Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / L, t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L);
  return cross < tol && t > -tol / L && t < 1 + tol / L;
}
function edgeInside(e, o) { return onSegment(e.a, o.a, o.b) && onSegment(e.b, o.a, o.b); }
function freeEdges(shapes = state.shapes) { const all = shapes.flatMap(shapeEdges); return all.filter((e, i) => !all.some((o, j) => j !== i && (sameEdge(e.a, e.b, o.a, o.b) || edgeInside(e, o)))); }
// ---------- 辺の途中から（v13.9、障害物を避けるとき） ----------
// 接続する辺 A–B の途中の点 P（起点から d m）から、辺に沿って長さ length の区間を底辺にする。
// part = { from: "a"|"b"（起点が辺の始点か終点か）, d: 起点から P までの距離, length: 底辺の長さ }。
// 起点から測った距離で持つので、前の図形を直して辺の長さが変わっても「B から 1.2 m」の位置を保つ
function subEdge(edge, part) {
  const L = dist(edge.a, edge.b), u = { x: (edge.b.x - edge.a.x) / L, y: (edge.b.y - edge.a.y) / L };
  if (!(part.d >= 0)) throw Error("起点から点 P までの距離を入れてください。");
  if (!(part.length > 0)) throw Error("底辺の長さを入れてください。");
  if (part.d + part.length > L + 0.005) throw Error(part.d
    ? `点 P から測った底辺（${fmtLen(part.d)} + ${fmtLen(part.length)} m）が、接続する辺の長さ（${fmtLen(L)} m）を超えています。` // v13.9 の記録
    : `起点から測った長さ（${fmtLen(part.length)} m）が、接続する辺の長さ（${fmtLen(L)} m）を超えています。`);
  const length = Math.min(part.length, L - part.d); // 5mm 以内のはみ出しは辺の端までにそろえる
  const offset = part.from === "b" ? L - part.d - length : part.d; // 辺の始点（edge.a）から区間の始まりまで
  const a = { x: edge.a.x + u.x * offset, y: edge.a.y + u.y * offset }, b = { x: a.x + u.x * length, y: a.y + u.y * length };
  return { shapeId: edge.shapeId, index: edge.index, a, b, part: { from: part.from === "b" ? "b" : "a", d: part.d, length } };
}
// 図形の点のうち、点 P（起点から d m の点）。起点が始点なら底辺の始まり、終点なら底辺の終わり
function partPoint(shape) {
  const q = shape.parent?.part, fromB = q?.from === "b";
  if (q && !q.d) return fromB ? shape.points[0] : shape.points[1]; // v14.0: 起点〜P の区間が底辺。P は起点と反対側の端
  return fromB ? shape.points[1] : shape.points[0];
}
function edgeByKey(key) { return freeEdges().find(e => edgeKey(e) === key); }
function outwardNormal(edge, shapes, flip = false) {
  const dx = edge.b.x - edge.a.x, dy = edge.b.y - edge.a.y, l = Math.hypot(dx, dy), left = { x: -dy / l, y: dx / l };
  const parent = shapes.find(s => s.id === edge.shapeId), c = centroid(parent.points);
  const cross = dx * (c.y - edge.a.y) - dy * (c.x - edge.a.x);
  let sign = cross > 0 ? -1 : 1; if (flip) sign *= -1;
  return { x: left.x * sign, y: left.y * sign };
}
// 三角形: 接続辺(またはc)を p0→p1 とし、b は p0 側、a は p1 側の辺
function makeTriangle(a, b, c, edge = null, shapes = state.shapes, flip = false) {
  if (![a, b, c].every(v => Number.isFinite(v) && v > 0)) throw Error("すべての辺に0より大きい数値を入力してください。");
  if (a + b <= c || a + c <= b || b + c <= a) throw Error("この3辺では三角形が成立しません。");
  let p0 = { x: 0, y: 0 }, p1 = { x: c, y: 0 }, normal = { x: 0, y: -1 };
  if (edge) { p0 = { ...edge.a }; p1 = { ...edge.b }; normal = outwardNormal(edge, shapes, flip); }
  const u = { x: (p1.x - p0.x) / c, y: (p1.y - p0.y) / c };
  const x = (b * b + c * c - a * a) / (2 * c), h = Math.sqrt(Math.max(0, b * b - x * x));
  const apex = { x: p0.x + u.x * x + normal.x * h, y: p0.y + u.y * x + normal.y * h };
  const s = (a + b + c) / 2;
  return { id: uid(), type: "triangle", points: [p0, p1, apex], area: Math.sqrt(s * (s - a) * (s - b) * (s - c)), dimensions: { a, b, c }, alignment: null, parent: edge ? { shapeId: edge.shapeId, index: edge.index } : null, flip: !!flip };
}
function makeTrapezoid(top, bottom, h, align, edge = null, shapes = state.shapes, flip = false) {
  if (![top, bottom, h].every(v => Number.isFinite(v) && v > 0)) throw Error("上底・下底・高さに0より大きい数値を入力してください。");
  let p0 = { x: 0, y: 0 }, p1 = { x: bottom, y: 0 }, normal = { x: 0, y: -1 };
  if (edge) { p0 = { ...edge.a }; p1 = { ...edge.b }; normal = outwardNormal(edge, shapes, flip); bottom = dist(p0, p1); }
  const u = { x: (p1.x - p0.x) / bottom, y: (p1.y - p0.y) / bottom };
  const offset = align === "left" ? 0 : align === "right" ? bottom - top : (bottom - top) / 2;
  const q0 = { x: p0.x + u.x * offset + normal.x * h, y: p0.y + u.y * offset + normal.y * h };
  const q1 = { x: q0.x + u.x * top, y: q0.y + u.y * top };
  return { id: uid(), type: "trapezoid", points: [p0, p1, q1, q0], area: (top + bottom) * h / 2, dimensions: { top, bottom, height: h }, alignment: align, parent: edge ? { shapeId: edge.shapeId, index: edge.index } : null, flip: !!flip };
}
function buildShape(spec, edge, shapes) {
  const d = spec.dimensions, base = edge ? dist(edge.a, edge.b) : null;
  return spec.type === "triangle" ? makeTriangle(d.a, d.b, base ?? d.c, edge, shapes, spec.flip) : makeTrapezoid(d.top, base ?? d.bottom, d.height, spec.alignment, edge, shapes, spec.flip);
}
// ---------- 閉じた図形の頂点をそろえる（v13.2） ----------
// 多角形を三斜で割ると、最後の三角形の頂点は既存の頂点に戻る。測った寸法で計算した頂点が既存の頂点の近くに来たら、
// その頂点に「閉じる」（同じ点にする）。ずれ（閉合差）は記録して表示し、テープの読み違いに気付けるようにする。
// 面積は測った寸法で計算したまま（ヘロンの公式）。そろえるのは図面上の点だけ。
// shape.close = [{ at: 新しい頂点の番号, shapeId, index: 閉じる先の頂点（図形と点の番号）, gap: ずれ m }]
function newPointIndexes(shape) { return shape.type === "triangle" ? [2] : [2, 3]; }
// 閉じる先の候補を探す（接続辺の両端と、もう一方の新しい頂点が選んだ点は除く）
function findClose(shape, prior) {
  const fixed = [shape.points[0], shape.points[1]], found = [];
  for (const at of newPointIndexes(shape)) {
    let best = null;
    prior.forEach(s => s.points.forEach((p, index) => {
      if (fixed.some(f => samePoint(f, p))) return;
      if (found.some(f => samePoint(prior.find(x => x.id === f.shapeId).points[f.index], p))) return;
      const gap = dist(shape.points[at], p);
      if (gap <= CLOSE_RADIUS && (!best || gap < best.gap)) best = { at, shapeId: s.id, index, gap };
    }));
    if (best) found.push(best);
  }
  return found;
}
// 閉じる: 新しい頂点を閉じる先の点に置き換え、ずれを測り直す。閉じる先の図形が無いとき（削除・差し替えで消えたとき）は、
// 前の位置（spec の点）と同じ点を持つ図形を探して付け替える。見つからなければ閉じない
function applyClose(shape, close, prior, oldPoints = null) {
  const kept = [];
  for (const c of close || []) {
    if (c.at >= shape.points.length) continue; // 台形→三角形の差し替えで無くなった頂点
    let owner = prior.find(s => s.id === c.shapeId), index = c.index;
    if (!owner?.points[index] && oldPoints?.[c.at]) {
      owner = prior.find(s => s.points.some(p => samePoint(p, oldPoints[c.at])));
      index = owner ? owner.points.findIndex(p => samePoint(p, oldPoints[c.at])) : -1;
    }
    const p = owner?.points[index];
    if (!p || [shape.points[0], shape.points[1]].some(f => samePoint(f, p))) continue;
    const gap = dist(shape.points[c.at], p);
    if (gap > CLOSE_RADIUS) continue; // 前の図形を直して離れてしまったら閉じない（遠くの点へ無理につながない）
    kept.push({ at: c.at, shapeId: owner.id, index, gap });
    shape.points[c.at] = { x: p.x, y: p.y };
  }
  if (kept.length) shape.close = kept; else delete shape.close;
  return shape;
}
function closeText(c, shapes, vertices = vertexList(shapes)) {
  const owner = shapes.find(s => s.id === c.shapeId), name = owner ? vertexNameOf(owner.points[c.index], vertices) : "?";
  return { name, gap: `${(c.gap * 100).toFixed(1)}cm`, warn: c.gap > CLOSE_WARN };
}
// 指定した図形につながっている図形（子・孫…）
function descendantsOf(id, shapes = state.shapes) {
  const out = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const s of shapes) if (!out.has(s.id) && s.parent && out.has(s.parent.shapeId)) { out.add(s.id); grew = true; } }
  out.delete(id);
  return out;
}
// 接続関係と寸法から図面全体を作り直す（途中の図形を修正・差し替え・削除したとき）
function rebuildShapes(specs) {
  const built = [];
  specs.forEach((spec, i) => {
    if (!spec.parent && i > 0) { built.push(structuredClone(spec)); return; }
    let edge = null;
    if (spec.parent) {
      const parent = built.find(b => b.id === spec.parent.shapeId);
      if (!parent) throw Error(`図形 ${i + 1} の接続先が見つかりません。`);
      edge = edgeOf(parent, spec.parent.index);
    }
    let shape;
    try {
      if (edge && spec.parent.part) edge = subEdge(edge, spec.parent.part); // 辺の途中から（v13.9）
      shape = buildShape(spec, edge, built);
    }
    catch (e) { throw Error(`図形 ${i + 1} が成り立たなくなります：${e.message}`); }
    shape.id = spec.id;
    if (edge?.part) shape.parent.part = edge.part;
    if (spec.close?.length) applyClose(shape, spec.close, built, spec.points);
    built.push(shape);
  });
  return built;
}
// v10 以前の記録には接続情報が無いので、点の一致から復元する
function withConnections(shapes) {
  const result = [];
  shapes.forEach((s, i) => {
    if ("parent" in s || i === 0) { result.push({ ...s, parent: s.parent ?? null, flip: !!s.flip }); return; }
    let found = null;
    for (const p of result) {
      for (let k = 0; k < p.points.length && !found; k++) {
        const e = edgeOf(p, k);
        if (samePoint(e.a, s.points[0], 1e-4) && samePoint(e.b, s.points[1], 1e-4)) found = e;
      }
      if (found) break;
    }
    if (!found) { result.push({ ...s, parent: null, flip: false }); return; }
    let flip = false;
    try { const trial = buildShape({ ...s, flip: false }, found, result); flip = !samePoint(trial.points.at(-1), s.points.at(-1), 1e-4); } catch { }
    result.push({ ...s, parent: { shapeId: found.shapeId, index: found.index }, flip });
  });
  return result;
}
function minAngle(shape) {
  const { a, b, c } = shape.dimensions;
  const ang = (x, y, z) => Math.acos(Math.min(1, Math.max(-1, (y * y + z * z - x * x) / (2 * y * z)))) * 180 / Math.PI;
  return Math.min(ang(a, b, c), ang(b, a, c), ang(c, a, b));
}
function ccw(points) { return signedArea(points) < 0 ? [...points].reverse() : points; }
// 凸多角形どうしの共通部分（Sutherland–Hodgman）
function clipConvex(subject, clip) {
  let out = ccw(subject); clip = ccw(clip);
  for (let i = 0; i < clip.length && out.length; i++) {
    const A = clip[i], B = clip[(i + 1) % clip.length], input = out; out = [];
    const side = p => (B.x - A.x) * (p.y - A.y) - (B.y - A.y) * (p.x - A.x);
    for (let j = 0; j < input.length; j++) {
      const P = input[j], Q = input[(j + 1) % input.length], sp = side(P), sq = side(Q);
      if (sp >= 0) out.push(P);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push({ x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t }); }
    }
  }
  return out;
}
function overlappingNumbers(shape, others) {
  return others.filter(o => {
    const inter = clipConvex(shape.points, o.points);
    return inter.length >= 3 && polygonArea(inter) > Math.max(1e-4, Math.min(shape.area, o.area) * 0.005);
  }).map(o => state.shapes.findIndex(s => s.id === o.id) + 1);
}
function vertexName(i) { let s = ""; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }
function vertexList(shapes) {
  const list = [];
  shapes.forEach(s => s.points.forEach(p => { if (!list.some(v => samePoint(v, p))) list.push({ x: p.x, y: p.y }); }));
  return list.map((p, i) => ({ ...p, name: vertexName(i) }));
}
function vertexNameOf(p, vertices) { return vertices.find(v => samePoint(v, p))?.name || "?"; }
function shapeVertexText(shape, vertices) { return shape.points.map(p => vertexNameOf(p, vertices)).join("-"); }

// ---------- 保存・設定 ----------
// 記録の検査: 端末内の保存データと JSON バックアップは、決まった形の値だけを取り出して使う（細工したデータで画面にスクリプトを入れられないように）
// 起動直後（state の初期化中）に呼ばれるので、const ではなく関数宣言にする
function isId(v) { return typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v); }
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }
function sanitizeRounding(o) {
  if (!o || ![1, 2, 3].includes(o.digits) || !["round", "floor", "ceil"].includes(o.method) || !["total", "each"].includes(o.sumMode)) return null;
  return { digits: o.digits, method: o.method, sumMode: o.sumMode };
}
function sanitizeShape(s) {
  if (!s || typeof s !== "object" || !isId(s.id) || !["triangle", "trapezoid"].includes(s.type)) return null;
  const n = s.type === "triangle" ? 3 : 4, keys = s.type === "triangle" ? ["a", "b", "c"] : ["top", "bottom", "height"];
  if (!Array.isArray(s.points) || s.points.length !== n || !s.points.every(p => p && isNum(p.x) && isNum(p.y))) return null;
  const d = s.dimensions || {};
  if (!keys.every(k => isNum(d[k]) && d[k] > 0)) return null;
  const alignment = s.type === "trapezoid" ? s.alignment : null;
  if (s.type === "trapezoid" && !["left", "center", "right"].includes(alignment)) return null;
  // 面積は保存された値を使わず、寸法から計算し直す（書き換えたデータで面積だけ違う値にならないように）
  let area;
  if (s.type === "triangle") {
    const { a, b, c } = d;
    if (a + b <= c || a + c <= b || b + c <= a) return null;
    const h = (a + b + c) / 2; area = Math.sqrt(h * (h - a) * (h - b) * (h - c));
  } else area = (d.top + d.bottom) * d.height / 2;
  if (!Number.isFinite(area) || area <= 0) return null; // 桁あふれ（1e200 など）や面積 0 の図形は弾く
  const out = { id: s.id, type: s.type, points: s.points.map(p => ({ x: p.x, y: p.y })), area, dimensions: Object.fromEntries(keys.map(k => [k, d[k]])), alignment };
  if ("parent" in s) { // 無い場合（v10 まで）は withConnections で点の位置から復元する
    const p = s.parent;
    if (p !== null && !(p && isId(p.shapeId) && Number.isInteger(p.index) && p.index >= 0 && p.index < 4)) return null;
    out.parent = p ? { shapeId: p.shapeId, index: p.index } : null; out.flip = s.flip === true;
    // 辺の途中から（v13.9）。形が正しくなければ記録ごと読まない（底辺の位置が分からなくなるため）
    if (p?.part !== undefined) {
      const q = p.part;
      if (!(q && (q.from === "a" || q.from === "b") && isNum(q.d) && q.d >= 0 && isNum(q.length) && q.length > 0)) return null;
      out.parent.part = { from: q.from, d: q.d, length: q.length };
    }
  }
  // 閉じた頂点（v13.2）。形が正しくないものは捨てる（図形自体は残す）
  if (Array.isArray(s.close)) {
    const close = s.close.filter(c => c && Number.isInteger(c.at) && c.at >= 2 && c.at < n && isId(c.shapeId) && Number.isInteger(c.index) && c.index >= 0 && c.index < 4 && isNum(c.gap) && c.gap >= 0)
      .slice(0, 2).map(c => ({ at: c.at, shapeId: c.shapeId, index: c.index, gap: c.gap }));
    if (close.length) out.close = close;
  }
  return out;
}
function sanitizeRecord(r) {
  if (!r || typeof r !== "object" || !isId(r.id) || typeof r.name !== "string" || !r.name.trim()) return null;
  if (!Array.isArray(r.shapes) || !r.shapes.length || r.shapes.length > 1000) return null;
  const shapes = r.shapes.map(sanitizeShape);
  if (shapes.some(s => !s)) return null;
  // 接続の検査: 図形の ID は重複しない。接続先は自分より前の図形で、辺の番号はその図形の辺の数より小さい
  const seen = new Map();
  for (const s of shapes) {
    if (seen.has(s.id)) return null;
    if (s.parent) { const p = seen.get(s.parent.shapeId); if (!p || s.parent.index >= p.points.length) return null; }
    // 閉合の意味の検査（v13.3、Codex レビュー P2）: 閉じる先は自分より前の図形の実在する頂点で、新しい頂点の番号は重複せず、
    // 保存された座標が閉じる先の頂点と一致し、接続辺の両端ではなく、ずれが閉じる範囲内であること。合わないものは閉合の情報だけ捨てる（図形は残す）
    if (s.close) {
      const ats = new Set();
      s.close = s.close.filter(c => {
        const target = seen.get(c.shapeId)?.points[c.index];
        const ok = target && !ats.has(c.at) && samePoint(s.points[c.at], target) && ![s.points[0], s.points[1]].some(f => samePoint(f, target)) && c.gap <= CLOSE_RADIUS + 1e-9;
        if (ok) ats.add(c.at);
        return ok;
      });
      if (!s.close.length) delete s.close;
    }
    seen.set(s.id, s);
  }
  const rounding = sanitizeRounding(r.rounding), str = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
  return {
    id: r.id, name: r.name.slice(0, 200), date: typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "",
    designArea: isNum(r.designArea) && r.designArea > 0 ? r.designArea : null, memo: str(r.memo, 2000), shapes,
    total: isNum(r.total) ? r.total : 0, ...(rounding ? { rounding } : {}), createdAt: str(r.createdAt, 40), updatedAt: str(r.updatedAt, 40),
  };
}
// 検査で読み込めない記録があったときは、上書きで消えないよう元のデータを別のキーに残す
function loadRecords() {
  const BACKUP_KEY = "field-area-drawings-v2-rejected"; // ここも state の初期化中に動くので、外の const は使わない
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    const v = JSON.parse(raw || "[]");
    if (!Array.isArray(v)) throw Error("not array");
    const records = v.map(sanitizeRecord).filter(Boolean);
    // 退避の書き込みに失敗しても（容量不足など）、読み込めた記録は使う
    if (records.length < v.length) {
      loadRecords.rejected = v.length - records.length;
      try { localStorage.setItem(BACKUP_KEY, raw); } catch { loadRecords.backupFailed = true; }
    }
    return records;
  } catch { // 保存データ全体が読めない（途中で切れた JSON など）、または端末の保存領域そのものが使えない（getItem が例外）
    if (raw) {
      loadRecords.rejected = "all";
      try { localStorage.setItem(BACKUP_KEY, raw); } catch { loadRecords.backupFailed = true; }
    } else loadRecords.rejected = "storage";
    return [];
  }
}
// 書き込めたときだけ state.records を差し替える。失敗したら（容量不足など）画面で知らせ、false を返す
function persist(records) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); }
  catch { showToast("端末に保存できませんでした（空き容量の不足など）。この図面は「PDF出力」で残してください"); return false; } // JSON 保存は保存済みの記録だけなので案内しない
  state.records = records; return true;
}
// 作図中の図面（図形・名称・日付・設計面積・メモ）を、保存・読み込みした時点と比べて、未保存の変更があるかを見る
function drawingSnapshot() { return JSON.stringify({ shapes: state.shapes, name: $("name").value.trim(), date: $("date").value, design: $("designArea").value.trim(), memo: $("memo").value.trim() }); }
function markSaved() { state.savedSnapshot = drawingSnapshot(); }
function isDirty() { return !!state.editingId || drawingSnapshot() !== state.savedSnapshot; } // 図形の修正中（未確定）も変更ありとして扱う
// 下書き: 未保存の変更がある間は、作図中の図面を端末に残す。スマホがアプリを閉じても（カメラに切り替えた間など）、次に開いたときに戻せるように
const DRAFT_KEY = "field-area-draft-v1";
function saveDraft() {
  try {
    if (!isDirty()) { localStorage.removeItem(DRAFT_KEY); return; }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), recordId: state.recordId, recordBase: state.recordBase, savedSnapshot: state.savedSnapshot, shapes: state.shapes, name: $("name").value, date: $("date").value, designArea: $("designArea").value, memo: $("memo").value }));
    state.draftFailed = false;
  } catch { // 下書きを残せないとき（空き容量の不足など）は、アプリが閉じられると作業が消えるので、一度知らせる
    if (!state.draftFailed) showToast("作業中の図面を端末に残せませんでした（空き容量の不足など）。こまめに「図面を保存」してください");
    state.draftFailed = true;
  }
}
// 起動時に下書きがあれば戻す。戻したら true
function restoreDraft() {
  let d;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return false; }
  if (!d || typeof d !== "object" || !Array.isArray(d.shapes)) return false;
  const str = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
  let shapes = [];
  if (d.shapes.length) { // 図形は保存データと同じ検査を通す（壊れた下書きは使わない）
    const checked = sanitizeRecord({ id: "draft", name: "下書き", shapes: d.shapes });
    if (!checked) return false;
    shapes = checked.shapes;
  }
  const recordId = isId(d.recordId) && state.records.some(r => r.id === d.recordId) ? d.recordId : null;
  state.shapes = withConnections(shapes); state.recordId = recordId; state.selectedEdge = null; state.editingId = null;
  $("name").value = str(d.name, 60); $("date").value = /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : today(); $("designArea").value = str(d.designArea, 40); $("memo").value = str(d.memo, 500);
  state.savedSnapshot = typeof d.savedSnapshot === "string" ? d.savedSnapshot : "";
  state.recordBase = recordId && typeof d.recordBase === "string" ? d.recordBase : null;
  $("saveDrawingButton").textContent = recordId ? "変更を保存" : "図面を保存";
  return isDirty();
}
function loadSettings() {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
    return sanitizeRounding(s) ? s : { ...s, ...DEFAULT_SETTINGS_ROUNDING() };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function DEFAULT_SETTINGS_ROUNDING() { const { digits, method, sumMode } = DEFAULT_SETTINGS; return { digits, method, sumMode }; }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { } }

// ---------- 図面 ----------
function color(i) { return ["#dce879", "#a9d8c3", "#f2c98b", "#bfc9eb", "#e6b8c5", "#c9df9c"][i % 6]; }
function viewBoxFor(points, padRatio = .22) {
  if (!points.length) return "0 0 700 430";
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1), pad = Math.max(w, h) * padRatio;
  return `${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`;
}
function fitView() { const ghost = state.candidate?.shape; state.viewBox = viewBoxFor([...state.shapes, ...(ghost ? [ghost] : [])].flatMap(s => s.points)); }
function svgMarkup(shapes, { viewBox, selectedEdge = null, ghost = null, interactive = false, textScale = 1, edges = null }) {
  if (!shapes.length && !ghost) return '<text x="350" y="205" text-anchor="middle" fill="#829189" font-size="18">ここに連続図面が表示されます</text><text x="350" y="235" text-anchor="middle" fill="#9aa69f" font-size="12">寸法を入力して最初の図形を追加</text>';
  const vb = viewBox.split(/\s+/).map(Number), scale = Math.max(vb[2], vb[3]);
  const t = scale * textScale, labelSize = t * .045, edgeSize = t * .025, labelOffset = t * .012, halo = t * .006, vertexSize = t * .03;
  const all = ghost ? [...shapes, ghost] : shapes, vertices = vertexList(all), center = centroid(all.flatMap(s => s.points));
  // 描く順（v13.4）: ①全図形の塗り → ②選べる辺の線 → ③点線の図形 → ④文字（図形番号・辺の長さ・点線の寸法・頂点名）→ ⑤タップ用の透明な線。
  // 図形ごとに「塗り→文字」と描くと、後から描く図形の半透明の塗りが前の図形の文字を覆って薄くなるため、文字はすべて塗りの後にまとめて描く
  let fills = "", lines = "", ghostFill = "", texts = "", hits = "";
  const labeled = [];
  shapes.forEach((s, i) => {
    const c = centroid(s.points);
    fills += `<polygon class="shape-polygon" points="${s.points.map(p => `${p.x},${p.y}`).join(" ")}" fill="${color(i)}" fill-opacity=".78"/>`;
    texts += `<text class="shape-label" style="font-size:${labelSize}px" x="${c.x}" y="${c.y}">${i + 1}</text>`;
    shapeEdges(s).forEach(e => {
      if (labeled.some(o => sameEdge(e.a, e.b, o.a, o.b))) return;
      labeled.push(e);
      const m = midpoint(e.a, e.b);
      texts += `<text class="edge-length" style="font-size:${edgeSize}px;stroke-width:${halo}px" x="${m.x}" y="${m.y - labelOffset}">${fmtLen(dist(e.a, e.b))}m</text>`;
    });
  });
  if (interactive) (edges || freeEdges(shapes)).forEach(e => {
    const key = edgeKey(e);
    lines += `<line class="edge-line ${selectedEdge === key ? "selected" : ""}" x1="${e.a.x}" y1="${e.a.y}" x2="${e.b.x}" y2="${e.b.y}"/>`;
    hits += `<line class="edge-hit" data-edge="${esc(key)}" x1="${e.a.x}" y1="${e.a.y}" x2="${e.b.x}" y2="${e.b.y}"/>`;
  });
  if (ghost) {
    const gc = centroid(ghost.points);
    ghostFill += `<polygon class="ghost-polygon" points="${ghost.points.map(p => `${p.x},${p.y}`).join(" ")}"/>`;
    (ghost.close || []).forEach(c => { const p = ghost.points[c.at]; ghostFill += `<circle class="close-mark ${c.gap > CLOSE_WARN ? "warn" : ""}" cx="${p.x}" cy="${p.y}" r="${t * .022}"/>`; }); // 閉じる頂点を丸で示す
    const names = ghost.type === "triangle" ? ["c", "a", "b"] : ["下底", null, "上底", null];
    const measured = ghost.type === "triangle" ? [ghost.dimensions.c, ghost.dimensions.a, ghost.dimensions.b] : [ghost.dimensions.bottom, null, ghost.dimensions.top, null];
    shapeEdges(ghost).forEach((e, i) => {
      if (!names[i] || (i === 0 && ghost.parent && !ghost.parent.part)) return; // 接続辺は既存の長さ表示と重なるので出さない（辺の途中からのときは出す）
      const m = midpoint(e.a, e.b), dx = m.x - gc.x, dy = m.y - gc.y, l = Math.hypot(dx, dy) || 1;
      // 測った寸法を出す（頂点を既存の点に閉じると、図面上の長さは少し変わるため）
      texts += `<text class="ghost-label" style="font-size:${edgeSize * 1.15}px;stroke-width:${halo}px" x="${m.x + dx / l * edgeSize * 1.6}" y="${m.y + dy / l * edgeSize * 1.6}">${names[i]} ${fmtLen(measured[i] ?? dist(e.a, e.b))}</text>`;
    });
  }
  vertices.forEach(v => {
    const dx = v.x - center.x, dy = v.y - center.y, l = Math.hypot(dx, dy) || 1;
    texts += `<circle class="vertex-dot" cx="${v.x}" cy="${v.y}" r="${t * .006}"/><text class="vertex-label" style="font-size:${vertexSize}px;stroke-width:${halo}px" x="${v.x + dx / l * vertexSize}" y="${v.y + dy / l * vertexSize}">${v.name}</text>`;
  });
  return fills + lines + ghostFill + texts + hits;
}
function renderCanvas(autoFit = false) {
  if (autoFit) fitView();
  // 修正中は、つなぎ直せる辺（差し替え）を選べるようにする
  const opts = { selectedEdge: state.editingId ? state.editParentKey : state.selectedEdge, ghost: state.candidate?.shape, interactive: true, edges: selectableEdges() };
  const svg = $("drawingCanvas");
  svg.setAttribute("viewBox", state.viewBox); svg.innerHTML = svgMarkup(state.shapes, { ...opts, viewBox: state.viewBox });
  if (measureOpen()) {
    // 全画面は図面が小さくなりやすいので、余白を詰めて文字を大きめに描く
    const viewBox = measureViewBox(state.candidate?.shape);
    const big = $("measureCanvas"); big.setAttribute("viewBox", viewBox); big.innerHTML = svgMarkup(state.shapes, { ...opts, viewBox, textScale: 1.6 });
  }
}
// ---------- 全画面の拡大表示（v12.8） ----------
// 詰めた表示（キーボードが出て画面が低いとき）では、図面全体ではなく接続辺のまわりを拡大する。
// 範囲は辺の選択・追加・反転・表示の切り替えのときだけ決め直し、数字を話すたびには動かさない（点線がはみ出すときだけ広げる）
function measureZoomOn() { return $("measureOverlay").classList.contains("compact") && state.settings.measureZoom && state.shapes.length >= 2; }
function focusRegion() {
  const editing = editingShape();
  const at = pts => pts.map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(" "); // 図形を修正して辺が動いたら、範囲も決め直す（キーに位置を含める）
  if (editing) { // 修正中は、修正する図形と、つなぎ直す辺（差し替え）のまわり
    const e = lockedEdge(), extra = e ? [e.a, e.b] : [];
    return { key: `edit:${editing.id}:${state.editParentKey}:${at(editing.points)}`, points: [...editing.points, ...extra] };
  }
  const edge = lockedEdge(); if (!edge) return null;
  // 接続辺の両端と、その外側（新しい図形が入るところ）に辺の長さぶん、内側に少しの余白
  const flip = $("flipDirection").checked, L = dist(edge.a, edge.b);
  const u = { x: (edge.b.x - edge.a.x) / L, y: (edge.b.y - edge.a.y) / L }, n = outwardNormal(edge, state.shapes, flip), points = [];
  for (const s of [-0.3, 1.1]) for (const t of [-0.3, 1.3]) points.push({ x: edge.a.x + u.x * L * t + n.x * L * s, y: edge.a.y + u.y * L * t + n.y * L * s });
  return { key: `edge:${edgeKey(edge)}:${flip}:${at([edge.a, edge.b])}`, points };
}
function insideBox(p, points) {
  const xs = points.map(q => q.x), ys = points.map(q => q.y);
  return p.x >= Math.min(...xs) && p.x <= Math.max(...xs) && p.y >= Math.min(...ys) && p.y <= Math.max(...ys);
}
function measureViewBox(ghost) {
  const all = [...state.shapes, ...(ghost ? [ghost] : [])].flatMap(s => s.points);
  const region = measureZoomOn() ? focusRegion() : null;
  if (!region) return viewBoxFor(all, .12);
  if (state.zoom.key !== region.key) state.zoom = { key: region.key, points: region.points };
  if (ghost && ghost.points.some(p => !insideBox(p, state.zoom.points))) state.zoom.points = [...state.zoom.points, ...ghost.points]; // 広げるだけで、狭めない
  return viewBoxFor(state.zoom.points, .06);
}
function toggleMeasureZoom() {
  state.settings.measureZoom = !state.settings.measureZoom; saveSettings();
  state.zoom = { key: null, points: [] }; syncMeasureTools(); renderCanvas();
}
// 入力欄の文字の代わりに、読み取った数字だけを表示する（入力欄の値は書き換えない。話している最中に書き換えると、iPhone で文字が二重に入るため）
function applyNumbersOnly() { $("measureOverlay").classList.toggle("numbers-only", state.settings.measureKeyboard !== "numeric" && !state.settings.showRaw); }
function updateQuickNumbers() {
  const el = $("quickNumbers");
  const active = activeQuickText(); // 合図で使い終わった部分より後ろ（今の図形の寸法）だけ
  if (!active.replace(/^[\s、。,.!！?？]+/, "").trim()) { el.innerHTML = ""; return; }
  const values = quickValues();
  el.classList.toggle("guessed", values.glued || !!state.signal.hold); // つながった数を分けたときは色を変えて、確認が要ることを示す
  el.innerHTML = values.length ? values.map(v => `<span>${fmtLen(v)}</span>`).join("") : '<span class="qn-wait">…</span>'; // 数字が無い言葉だけのときは「…」
}

// ---------- 入力フォーム ----------
function editingShape() { return state.editingId ? state.shapes.find(s => s.id === state.editingId) : null; }
function baseLocked() { const editing = editingShape(); return editing ? !!editing.parent : state.shapes.length > 0; }
// 差し替え（v13.2）: 修正中の図形をつなぎ直せる辺。修正中の図形とその先の図形を除いた図面の外周の辺のうち、
// 修正中の図形より前の図形の辺（作り直しは図形の順に行うので、後ろの図形にはつなげない）
function editEdges() {
  const editing = editingShape(); if (!editing?.parent) return [];
  const k = state.shapes.indexOf(editing), drop = descendantsOf(editing.id); drop.add(editing.id);
  const before = new Set(state.shapes.slice(0, k).map(s => s.id));
  return freeEdges(state.shapes.filter(s => !drop.has(s.id))).filter(e => before.has(e.shapeId));
}
function selectableEdges() { return state.editingId ? editEdges() : freeEdges(); }
function lockedEdge() {
  const editing = editingShape();
  if (editing) return editing.parent ? editEdges().find(e => edgeKey(e) === state.editParentKey) || null : null;
  return state.shapes.length ? edgeByKey(state.selectedEdge) : null;
}
function refreshEdgeOptions() {
  const editing = editingShape(), edges = selectableEdges(), vertices = vertexList(state.shapes);
  const key0 = editing ? state.editParentKey : state.selectedEdge;
  if (!edges.length) { if (!editing) state.selectedEdge = null; $("edgeSelect").innerHTML = ""; return; }
  const pick = edges.some(e => edgeKey(e) === key0) ? key0 : edgeKey(edges[0]);
  if (editing) state.editParentKey = pick; else state.selectedEdge = pick;
  $("edgeSelect").innerHTML = edges.map(e => {
    const si = state.shapes.findIndex(s => s.id === e.shapeId) + 1, key = edgeKey(e);
    return `<option value="${esc(key)}" ${key === pick ? "selected" : ""}>${vertexNameOf(e.a, vertices)}–${vertexNameOf(e.b, vertices)}（${dist(e.a, e.b).toFixed(3)} m）・図形 ${si}</option>`;
  }).join("");
}
// 図面や一覧で辺を選んだとき（修正中は、つなぎ直す辺として選ぶ）
function selectEdge(key) {
  if (!selectableEdges().some(e => edgeKey(e) === key)) return false;
  if (state.editingId) state.editParentKey = key; else state.selectedEdge = key;
  return true;
}
function applySharedLength() {
  const edge = lockedEdge(); if (!edge || !baseLocked()) return;
  if (partialOn()) return; // 辺の途中まで（v14.0）: c は起点から測った長さを手で入れる
  const l = fmtLen(dist(edge.a, edge.b));
  $("sideC").value = l; $("bottomBase").value = l;
}
// 辺の途中まで（v14.0、障害物を避ける）の入力: 起点（A か B）から辺に沿って c m の区間（起点〜点 P）を、新しい図形の1辺（底辺）にする。
// 保存の形は v13.9 と同じ part = { from, d, length }（d は起点から区間の始まりまで。v14.0 では常に 0）
function partialOn() { return baseLocked() && $("partialToggle").checked; }
function partialFrom() { return document.querySelector('input[name="partialFrom"]:checked').value; }
function formPart() {
  const length = num(state.mode === "triangle" ? "sideC" : "bottomBase");
  if (!Number.isFinite(length) || length <= 0) throw Error(`${state.mode === "triangle" ? "c に" : "下底に"}、起点から辺に沿って測った長さを入れてください。`);
  return { from: partialFrom(), d: 0, length };
}
function resetPartial() {
  $("partialToggle").checked = false;
  document.querySelector('input[name="partialFrom"][value="a"]').checked = true;
}
function requiredFields() { return state.mode === "triangle" ? ["sideA", "sideB", "sideC"] : ["topBase", "bottomBase", "height"]; }
function quickTargets() { const locked = baseLocked(); return state.mode === "triangle" ? (locked ? ["sideA", "sideB"] : ["sideA", "sideB", "sideC"]) : (locked ? ["topBase", "height"] : ["topBase", "bottomBase", "height"]); }
function updateQuickHint() {
  const targets = quickTargets().map(id => FIELD_LABELS[id]);
  $("quickHint").textContent = `${targets.join("・")} の順に${targets.length}つ${baseLocked() ? `（${state.mode === "triangle" ? "c" : "下底"}は接続辺）` : ""}`;
  $("quickInput").placeholder = targets.length === 2 ? "例：4.25 3.01" : "例：3.01 4.25 3";
}
// ---------- 合図（はい・OK）で追加 ----------
// 音声入力は話している途中で前の文字を書き直すことがある。追加済みの数は「先頭から数えて何まとまり目まで使ったか」で覚え、
// 入力のたびに先頭から数え直す。書き直しで数が減っても追加し直さない。
// barrier: 二重入力を読み飛ばしたときの区切り（その時点の合図の数と、それまでに使ったまとまりの数）
function resetSignalSession() { state.signal = { needs: [], added: 0, barrier: null }; }
// 全画面の入力欄の数を読む。音声入力のときだけ、速く話してつながった数（3.12.13.0）を分ける。分けたときは values.glued = true
function parseQuick(text) {
  const opts = { splitGlued: state.settings.measureKeyboard !== "numeric" }, values = parseLengths(text, opts);
  values.glued = !!opts.glued; return values;
}
function signalGroups(text, limit = Infinity) {
  const signals = findSignals(text), barrier = state.signal.barrier;
  let groups = [], rest = 0, from = 0;
  if (barrier) { // 区切りまでの文字はすべて使い終わった扱い
    groups = new Array(barrier.groups).fill(null);
    from = Math.min(barrier.signals, signals.length);
    rest = from ? signals[from - 1].end : 0;
  }
  // 合図ごとに寸法を確定する（v13.5）: 合図と合図の間の数を見て、
  //   ・まだ何も確定していなければ、その数をすべて確定（「3.01 4.25 3 はい」のまとめ言いもこれまでどおり。数が多すぎるときは processSignals で止める）
  //   ・確定済みがあっても、足して必要な数に収まるなら、その区間の数をすべて確定（「3 はい 3.01 4.25 はい」）
  //   ・必要な数を超えるときは、言い直しや「さん 3」のような重複とみなし、その区間の最後の数だけを確定
  // 確定した数が必要な数（2つ・3つ）に届いた合図で、1つの図形のまとまりにする
  // 追加できなかったまとまりから持ち越した数（v13.7）は、次のまとまりの最初に入れておく
  const carried = g => state.signal.carry?.index === g ? [...state.signal.carry.values] : [];
  let confirmed = carried(groups.length), glued = false, segStart = rest;
  for (const sig of signals.slice(from)) {
    if (groups.length >= limit) break;
    const need = state.signal.needs[groups.length] ?? quickTargets().length;
    const nums = parseQuick(text.slice(segStart, sig.index)); segStart = sig.end;
    if (!nums.length) continue; // 数の無い合図（続けて「はい」と言った等）は飛ばす
    takeNumbers(confirmed, nums, need);
    glued ||= !!nums.glued;
    if (confirmed.length < need) continue; // 1つ目の数字の後の合図などは、次の数字を待つ
    const values = confirmed; values.glued = glued;
    groups.push(values); rest = sig.end;
    confirmed = carried(groups.length); glued = false;
  }
  return { groups, rest };
}
// 区間の数を確定済みに足す（v13.5。上の決まり）
function takeNumbers(confirmed, nums, need) {
  if (!confirmed.length || confirmed.length + nums.length <= need) confirmed.push(...nums); else confirmed.push(nums[nums.length - 1]);
}
// 今の図形の寸法として見せる数（v13.5）: signalGroups と同じ決まりで、使い終わった部分より後ろの文字から作る。
// 最後の合図より後ろの、まだ合図が無い数も同じ決まりで足す（話している途中の寸法を見せるため）
function quickValues() {
  const text = activeQuickText(), sigs = findSignals(text);
  // 追加できなかったまとまりから持ち越した数（v13.7）があれば、それに続けて足す
  const carry = state.signal.carry?.index === state.signal.added ? state.signal.carry.values : [];
  let confirmed = [...carry], glued = false, start = 0;
  const need = quickTargets().length;
  const take = nums => { if (!nums.length) return; takeNumbers(confirmed, nums, need); glued ||= !!nums.glued; };
  for (const sig of sigs) { take(parseQuick(text.slice(start, sig.index))); start = sig.end; }
  take(parseQuick(text.slice(start)));
  confirmed.glued = glued;
  return confirmed;
}
// 使い終わったまとまりより後ろの文字（今の図形の寸法）
function activeQuickText() {
  const text = $("quickInput").value;
  return state.signal.added ? text.slice(signalGroups(text, state.signal.added).rest) : text;
}
// 新しくそろったまとまりがあれば図形を追加する。追加したら true
function processSignals() {
  // 重なりの確認を出している間は、次のまとまりを処理しない（確認中の図形が別の寸法に置き換わらないように）
  // 閉じる候補の確認待ち（v13.3）の間も、次のまとまりは処理しない
  if (!state.settings.signalAdd || $("confirmDialog").open || state.closeHold) return false;
  // 確認待ちを取り消した後は、前の合図では追加しない。新しい合図（「はい」「OK」）が増えたら進める（v13.4）
  if (state.closeRelease != null) {
    if (findSignals($("quickInput").value).length <= state.closeRelease) return false;
    state.closeRelease = null;
  }
  const k = state.signal.added, { groups } = signalGroups($("quickInput").value, k + 1);
  if (groups.length <= k) return false;
  const targets = quickTargets(), values = groups[k];
  if (values.glued || state.signal.hold) {
    // つながった数を推測で分けたときは、合図だけでは追加しない（たまたま三角形が成り立つ別の寸法で追加されないように）。分けた数を見せ、「追加」を押してもらう
    const text = values.map(fmtLen).join(" ");
    if (state.signal.gluedLogged !== text) { logVoice(`つながった数を分けたので自動追加せず: ${text}`); state.signal.gluedLogged = text; }
    return false;
  }
  state.signal.needs[k] = targets.length; state.signal.added = k + 1;
  if (values.length > targets.length) {
    // 合図までに数が多い（騒音で余分な数が入ったなど）ときは、どれが寸法か決められないので追加しない
    const msg = `数が${values.length}個あります（${values.map(fmtLen).join(" ")}）。`;
    state.autoError = msg; $("message").textContent = msg;
    logVoice(`数が多いので追加せず: ${values.map(fmtLen).join(" ")}`);
    showToast(`追加できません：${msg} 読み直してください`);
    DIMENSION_FIELDS.forEach(id => { if (!$(id).readOnly) $(id).value = ""; });
    return processSignals();
  }
  targets.forEach((id, i) => { $(id).value = fmtLen(values[i]); });
  // 閉じる候補がある（既存の頂点の近くに来た）ときは、合図だけでは追加しない（v13.3、Codex レビュー P1）。
  // 閉じるかどうかで図面の頂点・外周の辺・次の接続先が変わるので、「閉じて追加」「閉じずに追加」を押してもらう。
  // このまとまりは使い終わりにせず、入力欄の数字はそのまま見せる
  if (!state.noClose) {
    let cand = null; try { cand = buildCandidate(); } catch { }
    if (cand?.closeInfo.length) {
      state.signal.added = k; delete state.signal.needs[k];
      state.closeHold = true;
      const c = cand.closeInfo[0];
      logVoice(`閉じる候補があるので自動追加せず: ${values.map(fmtLen).join(" ")}（頂点 ${c.name}・ずれ ${c.gap}）`);
      // 大きなお知らせは図面（点線）を隠すので出さない。入力欄の上に選ぶボタンを出し、振動で知らせる（Android）
      navigator.vibrate?.([60, 80, 60]);
      return false;
    }
  }
  logVoice(`合図で追加: ${values.map(fmtLen).join(" ")}`);
  if (addShape({ auto: true })) return true;
  // 三角形が成り立たないなど追加できなかったとき（v13.7、ユーザー指示）: 最後に言った数だけを捨て、前の数は次のまとまりに持ち越す。
  // 最初の三角形は「3 3 〇」の〇、2つ目以降は「3 〇」の〇を消し、次に言った数で埋める
  const keep = values.slice(0, targets.length - 1), dropped = values[targets.length - 1];
  state.signal.carry = { index: k + 1, values: keep };
  state.autoError = `${state.autoError} 最後の数（${fmtLen(dropped)}）を消しました。言い直してください`;
  logVoice(`追加できず、最後の数を消して前の数を残す: 残す ${keep.map(fmtLen).join(" ") || "なし"} ／ 消す ${fmtLen(dropped)}`);
  showToast(`追加できません：最後の数（${fmtLen(dropped)}）を消しました。言い直してください`);
  DIMENSION_FIELDS.forEach(id => { if (!$(id).readOnly) $(id).value = ""; });
  targets.forEach((id, i) => { if (i < keep.length) $(id).value = fmtLen(keep[i]); });
  return processSignals();
}
// 追加の直後に、話した文字がそっくりもう一度入った場合（iPhone で起きることがある）は、追加せずに読み飛ばす
function skipDuplicatedInsert(prev, now) {
  if (!state.settings.signalAdd || !state.signal.added || !now.startsWith(prev)) return false;
  const inserted = now.slice(prev.length), norm = t => t.replace(/\s/g, "");
  if (findSignals(inserted).length < 2 || !norm(prev).endsWith(norm(inserted))) return false;
  state.signal.barrier = { signals: findSignals(now).length, groups: state.signal.added }; // 入力欄にある文字はすべて使い終わった扱いにする
  logVoice(`二重入力を読み飛ばし: "${inserted}"`);
  showToast("同じ言葉が二重に入ったため、読み飛ばしました");
  return true;
}
function logVoice(text) {
  const t = new Date(), hms = [t.getHours(), t.getMinutes(), t.getSeconds()].map(v => String(v).padStart(2, "0")).join(":");
  state.voiceLog.push(`${hms} ${text}`);
  if (state.voiceLog.length > 80) state.voiceLog.shift();
}
function quickChips(values) { return quickTargets().map((id, i) => `<span class="chip ${values[i] === undefined ? "empty" : ""}">${FIELD_LABELS[id]} ${values[i] !== undefined ? fmtLen(values[i]) : "—"}</span>`).join(""); }
function applyQuickInput() {
  const text = $("quickInput").value, targets = quickTargets();
  if (!text.trim()) { // 入力欄を空にしたら寸法も消す（前の寸法のまま「追加」されないように）
    resetSignalSession(); state.lastQuick = text; $("quickParsed").innerHTML = quickChips([]); state.autoError = ""; state.closeHold = false; state.closeRelease = null; // 空でも「a・b」などの欄は見せる（何を話すか分かるように）
    state.zoom = { key: null, points: [] }; // 入力欄を空にしたら、広げた拡大範囲も元に戻す（大きな数を読み違えた後など）
    targets.forEach(id => { $(id).value = ""; }); updateQuickNumbers(); updatePreview(); return;
  }
  if (processSignals()) { state.lastQuick = $("quickInput").value; updateQuickNumbers(); return; }
  state.lastQuick = text;
  const values = quickValues();
  targets.forEach((id, i) => { $(id).value = values[i] !== undefined ? fmtLen(values[i]) : ""; });
  updateQuickNumbers();
  const chips = quickChips(values);
  let status;
  if (values.length < targets.length) status = `<span class="quick-status">あと${targets.length - values.length}つ</span>`;
  else if (values.length > targets.length) status = `<span class="quick-status warn">数が${values.length}個あります。最初の${targets.length}個を使います</span>`;
  else if (state.closeHold) status = `<span class="quick-status ok">✓ そろいました（閉じるかどうかを下のボタンで選んでください）</span>`;
  else status = `<span class="quick-status ok">✓ そろいました（${state.settings.signalAdd ? "「はい」「OK」" : "改行キー"}か「追加」で追加）</span>`;
  if (values.glued || state.signal.hold) status = values.length > targets.length
    ? `<span class="quick-status warn">数がつながって聞こえたので分けましたが、数が${values.length}個あります。入力欄を空にしてから言い直してください</span>`
    : `<span class="quick-status warn">数がつながって聞こえたので分けました。合っていれば「追加」を押してください（違うときは入力欄を空にしてから言い直し）</span>`;
  $("quickParsed").innerHTML = chips + status;
  updatePreview();
}
function buildCandidate() {
  const editing = editingShape(), fullEdge = lockedEdge(), flip = $("flipDirection").checked;
  if (!editing && state.shapes.length && !fullEdge) throw Error("接続する辺を選択してください。");
  const edge = fullEdge && partialOn() ? subEdge(fullEdge, formPart()) : fullEdge; // 辺の途中から（v13.9）
  const spec = state.mode === "triangle"
    ? { type: "triangle", dimensions: { a: num("sideA"), b: num("sideB"), c: num("sideC") }, flip }
    : { type: "trapezoid", dimensions: { top: num("topBase"), bottom: num("bottomBase"), height: num("height") }, alignment: alignment(), flip };
  let shape = buildShape(spec, edge, state.shapes);
  if (edge?.part) shape.parent.part = edge.part;
  const warnings = [];
  let rebuilt = null, drops = [], closeFound = [];
  if (editing) {
    shape.id = editing.id;
    const k = state.shapes.indexOf(editing), prior = state.shapes.slice(0, k);
    // 修正・差し替えでは、閉じる先を探し直す（種類や接続先を変えても、古い閉じ先に無理につながないように）。「閉じない」を押したときは閉じない
    closeFound = findClose(shape, prior);
    if (!state.noClose && closeFound.length) shape.close = closeFound.map(c => ({ ...c })); else delete shape.close;
    // 差し替えで台形→三角形にすると、4本目の辺につながっていた図形は行き場が無くなる → その先の図形ごと外す（確認してから）
    const lost = new Set();
    state.shapes.forEach(s => { if (s.parent?.shapeId === editing.id && s.parent.index >= shape.points.length) { lost.add(s.id); descendantsOf(s.id).forEach(id => lost.add(id)); } });
    drops = state.shapes.map((s, i) => lost.has(s.id) ? i + 1 : null).filter(Boolean);
    rebuilt = rebuildShapes(state.shapes.filter(s => !lost.has(s.id)).map(s => s.id === editing.id ? shape : s));
    shape = rebuilt.find(s => s.id === editing.id); // 閉じた後の形（点線もこれで描く）
    if (drops.length) warnings.push({ text: `図形 ${drops.join("・")} は、つながっていた辺が無くなるため削除されます。`, short: `図形 ${drops.join("・")} は削除されます` });
  } else {
    closeFound = findClose(shape, state.shapes);
    if (!state.noClose && closeFound.length) applyClose(shape, closeFound, state.shapes);
  }
  const closeInfo = (shape.close || []).map(c => closeText(c, state.shapes));
  closeInfo.filter(c => c.warn).forEach(c => warnings.push({ text: `頂点 ${c.name} とのずれが ${c.gap} あります（${CLOSE_WARN * 100}cm 超）。寸法を確認してください。`, short: `頂点 ${c.name} とのずれ ${c.gap}（寸法を確認）` }));
  if (shape.type === "triangle") {
    const m = minAngle(shape);
    if (m < THIN_ANGLE_DEG) warnings.push({ text: `最小角が ${m.toFixed(1)}° の細長い三角形です。テープの数cmの誤差が面積に大きく響くため、分け方の見直しや再計測を検討してください。`, short: `細長い三角形（最小角 ${m.toFixed(1)}°）` });
  }
  let hits;
  if (rebuilt) {
    // 修正のときは、作り直した後の位置で調べる。修正した図形だけでなく、つられて動いた後ろの図形どうしの重なりも見る
    const moved = rebuilt.filter(s => { const old = state.shapes.find(o => o.id === s.id); return s.id === shape.id || !old || s.points.some((p, k) => !samePoint(p, old.points[k])); });
    const set = new Set();
    moved.forEach(m => { const ns = overlappingNumbers(m, rebuilt.filter(o => o.id !== m.id)); if (ns.length) { set.add(state.shapes.findIndex(s => s.id === m.id) + 1); ns.forEach(n => set.add(n)); } });
    hits = [...set].sort((a, b) => a - b);
  } else hits = overlappingNumbers(shape, state.shapes);
  const overlapText = editing ? `図形 ${hits.join("・")} が重なります` : `図形 ${hits.join("・")} と重なっています`;
  if (hits.length) warnings.push({ text: `${overlapText}。「接続方向を反転する」や a・b の入れ替えを確認してください。`, short: `${overlapText}（反転・a⇄b を確認）` });
  // 閉じられる頂点があるのに「閉じない」にしているときは、その旨を出す
  const skipped = state.noClose ? closeFound.map(c => closeText(c, state.shapes)) : [];
  return { shape, warnings, overlap: hits.length > 0, rebuilt, drops, closeInfo, skipped };
}
// 閉じる頂点の表示（プレビュー用）。「閉じない／閉じる」のボタン付き
// 閉じるかどうかの確認待ちを取り消す（v13.4）。そのときの合図の数を覚え、新しい合図が来るまで自動では追加しない
function releaseCloseHold() {
  state.closeHold = false;
  state.closeRelease = findSignals($("quickInput").value).length;
  logVoice("寸法が変わり閉じる候補が無くなったので、確認待ちを取り消し");
}
function closeLine(cand) {
  // 合図で追加しようとして閉じる候補が見つかったとき（v13.3）: 選んでもらうボタン
  if (state.closeHold && cand.closeInfo.length) return `<span class="close-line hold ${cand.closeInfo.some(c => c.warn) ? "warn" : ""}">◎ ${cand.closeInfo.map(c => `頂点 ${c.name} に閉じますか？（ずれ ${c.gap}）`).join("、")} <span class="close-choices"><button type="button" class="close-add" data-close-add="close">閉じて追加</button><button type="button" class="close-add" data-close-add="open">閉じずに追加</button></span></span>`;
  if (cand.closeInfo.length) return `<span class="close-line ${cand.closeInfo.some(c => c.warn) ? "warn" : ""}">◎ ${cand.closeInfo.map(c => `頂点 ${c.name} に閉じます（ずれ ${c.gap}）`).join("、")} <button type="button" class="close-toggle" data-close-toggle>閉じない</button></span>`;
  if (cand.skipped.length) return `<span class="close-line off">${cand.skipped.map(c => `頂点 ${c.name} の近く（${c.gap}）ですが閉じません`).join("、")} <button type="button" class="close-toggle" data-close-toggle>閉じる</button></span>`;
  return "";
}
function updatePreview() {
  const box = $("previewBox"), status = $("measureStatus"), filled = requiredFields().every(id => $(id).value.trim() !== "");
  state.candidate = null;
  if (!filled) {
    if (state.closeHold) releaseCloseHold(); // 寸法が欠けたら、閉じるかどうかの確認待ちは取り消す（v13.4）
    box.className = "preview-box idle";
    box.textContent = "寸法を入れると、ここに面積が、図面に点線で追加位置が表示されます。";
    status.className = `measure-status ${state.autoError ? "error" : "idle"}`;
    // 合図で追加できなかったときは、次の寸法がそろうまで理由を出したままにする
    status.textContent = state.autoError ? `追加できませんでした：${state.autoError}${state.autoError.endsWith("ください") ? "" : " 読み直してください"}` : state.settings.signalAdd ? "寸法を話し、数がそろったら「はい」「OK」で追加します" : "寸法を話すか入力すると、図面に点線で表示されます（「はい」「OK」などの合図は無視します）";
  } else {
    try {
      const cand = buildCandidate(); state.candidate = cand;
      // 確認待ちの後で寸法・接続辺・反転などが変わり、閉じる候補が無くなったら、確認待ちを取り消す（v13.4、Codex 再レビュー P2）
      if (state.closeHold && !cand.closeInfo.length) releaseCloseHold();
      const editing = editingShape();
      const area = fmt(roundArea(cand.shape.area)), after = fmt(cand.rebuilt ? computeTotal(cand.rebuilt) : computeTotal([...state.shapes, cand.shape]));
      const redo = state.closeRelease != null ? `<span class="close-line off redo">寸法が変わったため、もう一度「はい」「OK」または「追加」を押してください</span>` : "";
      box.className = `preview-box${cand.warnings.length ? " has-warning" : ""}`;
      box.innerHTML = `<div class="preview-line"><span>${editing ? "修正後の図形" : "この図形"} <b>${area}</b> m²</span><span>${editing ? "修正後の合計" : "追加後の合計"} <b>${after}</b> m²</span></div>${closeLine(cand)}${redo}${cand.warnings.map(w => `<p class="warn">⚠ ${esc(w.text)}</p>`).join("")}`;
      status.className = "measure-status";
      status.innerHTML = `${editing ? "修正後" : "この図形"} <b>${area}</b> m² → 合計 <b>${after}</b> m²${closeLine(cand)}${redo}${cand.warnings.map(w => `<span class="warn">⚠ ${esc(w.short)}</span>`).join("")}`;
    } catch (e) {
      if (state.closeHold) releaseCloseHold(); // 寸法が成り立たなくなったときも取り消す
      box.className = "preview-box error";
      box.textContent = e.message;
      status.className = "measure-status error";
      status.textContent = e.message;
    }
  }
  syncMeasureTools();
  renderCanvas(true);
}
function clearInputs() {
  DIMENSION_FIELDS.forEach(id => $(id).value = "");
  $("quickInput").value = ""; $("quickParsed").innerHTML = quickChips([]); updateQuickNumbers(); resetSignalSession(); state.lastQuick = ""; state.autoError = "";
  state.zoom = { key: null, points: [] }; state.noClose = false; state.closeHold = false; state.closeRelease = null;
  $("flipDirection").checked = false;
  document.querySelector('input[name="alignment"][value="center"]').checked = true;
  $("message").textContent = "";
  resetPartial();
  applySharedLength();
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode").forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle("active", on); b.setAttribute("aria-checked", String(on)); });
  $("triangleFields").classList.toggle("hidden", mode !== "triangle");
  $("trapezoidFields").classList.toggle("hidden", mode !== "trapezoid");
  const keep = { on: $("partialToggle").checked, from: partialFrom() }; // 種類を変えても、辺の途中までの設定は残す
  clearInputs();
  if (keep.on) { $("partialToggle").checked = true; document.querySelector(`input[name="partialFrom"][value="${keep.from}"]`).checked = true; refreshPartialUi(); $("sideC").value = ""; $("bottomBase").value = ""; }
  updateQuickHint(); updatePreview();
}
function swapAB() {
  const values = quickValues();
  if (values.length >= 2) {
    [values[0], values[1]] = [values[1], values[0]];
    const hold = values.glued || !!state.signal.hold;
    $("quickInput").value = values.map(fmtLen).join(" "); resetSignalSession();
    if (hold) state.signal.hold = true; // 推測で分けた数は、入れ替えた後も（何度入れ替えても）確認待ちのまま（合図だけでは追加しない）
    applyQuickInput();
  } else {
    const a = $("sideA").value; $("sideA").value = $("sideB").value; $("sideB").value = a;
    updatePreview();
  }
  // 大きなお知らせは図面の数字を隠すので出さず、押したボタンと a・b の寸法を一瞬光らせる
  tapFlash(measureOpen() ? $("measureSwap") : $("swapButton"), ...document.querySelectorAll("#quickParsed .chip:nth-child(-n+2)"), $("sideA"), $("sideB"));
}
function tapFlash(...els) { els.forEach(el => { if (!el) return; el.classList.remove("tap-flash"); void el.offsetWidth; el.classList.add("tap-flash"); }); }
function undoLast() {
  ask("最後の図形を戻しますか？", "最後に追加した図形と、その接続を削除します。", () => { state.shapes.pop(); refresh(); showToast("最後の図形を戻しました"); if (measureOpen()) focusQuick(); });
}

// ---------- 図形の追加・修正 ----------
// auto: 合図で追加したとき。音声入力の最中なので入力欄の文字は書き換えない（iPhone で文字が二重になるのを防ぐ）
// closeChosen: 「閉じて追加」「閉じずに追加」を押したとき（閉じるかどうかは選んだので、ずれの確認画面は出さない）
function addShape({ auto = false, closeChosen = false } = {}) {
  let cand;
  if (!auto && $("quickInput").value.trim()) {
    // 推測で分けた数が必要な数より多いときは、どれが寸法か分からないので「追加」でも追加しない
    const values = quickValues();
    if ((values.glued || state.signal.hold) && values.length > quickTargets().length) { $("message").textContent = "数がつながって聞こえたので分けましたが、数が多すぎます。入力欄を空にしてから言い直してください。"; showToast("追加できません：入力欄を空にしてから言い直してください"); return false; }
  }
  try { cand = buildCandidate(); }
  catch (e) { $("message").textContent = e.message; if (auto) { state.autoError = e.message; showToast(`追加できません：${e.message} 読み直してください`); } return false; }
  const editing = editingShape();
  const clearAfterAdd = () => {
    state.autoError = "";
    if (!auto) { clearInputs(); return; }
    state.noClose = false; state.closeRelease = null;
    DIMENSION_FIELDS.forEach(id => $(id).value = "");
    $("flipDirection").checked = false;
    document.querySelector('input[name="alignment"][value="center"]').checked = true;
    $("message").textContent = "";
    applySharedLength();
  };
  const commit = () => {
    if (editing) {
      const n = state.shapes.findIndex(s => s.id === editing.id) + 1;
      state.shapes = cand.rebuilt; state.editingId = null;
      clearAfterAdd(); showToast(`図形 ${n} を修正しました`); refresh(); // refresh 中に続きの合図が失敗したら、そのお知らせを後に出す
    } else {
      state.shapes.push(cand.shape);
      const next = freeEdges().find(e => e.shapeId === cand.shape.id);
      if (next) state.selectedEdge = edgeKey(next);
      clearAfterAdd(); showToast(`図形 ${state.shapes.length} を追加しました`); refresh();
    }
    if (auto) navigator.vibrate?.(40);
    if (measureOpen()) focusQuick(); else if (!auto) $("quickInput").blur();
  };
  // 重なるとき・差し替えで消える図形があるときは確認する
  // 閉合差が 5cm を超えるときも確認する（v13.3、Codex レビュー P1）。ただし「閉じて追加」を押したときは選んだ後なので出さない
  const asks = cand.warnings.filter(w => /重な|削除されます/.test(w.text) || (!closeChosen && /とのずれが/.test(w.text))).map(w => w.text);
  // 見出しは、削除・重なり・閉合差で分ける（v13.4、Codex 再レビュー P3）
  const askTitle = cand.drops?.length ? "図形が削除されます" : cand.overlap ? "図形が重なっています" : "閉合差を確認してください";
  if (asks.length) ask(askTitle, `${asks.join("\n")}\nこのまま${editing ? "修正" : "追加"}しますか？`, commit, editing ? "修正する" : "追加する");
  else commit();
  return true;
}
function startEdit(id) {
  const shape = state.shapes.find(s => s.id === id); if (!shape) return;
  state.editingId = null; setMode(shape.type); state.editingId = id;
  state.editParentKey = shape.parent ? `${shape.parent.shapeId}:${shape.parent.index}` : null; // 辺を選び直さなければ、今の接続のまま
  const d = shape.dimensions;
  if (shape.type === "triangle") { $("sideA").value = fmtLen(d.a); $("sideB").value = fmtLen(d.b); $("sideC").value = fmtLen(d.c); }
  else { $("topBase").value = fmtLen(d.top); $("bottomBase").value = fmtLen(d.bottom); $("height").value = fmtLen(d.height); document.querySelector(`input[name="alignment"][value="${shape.alignment}"]`).checked = true; }
  $("flipDirection").checked = !!shape.flip;
  if (shape.parent?.part) { // 辺の途中まで（v14.0）。c（下底）には区間の長さが入っている
    $("partialToggle").checked = true;
    document.querySelector(`input[name="partialFrom"][value="${shape.parent.part.from}"]`).checked = true;
  }
  refresh();
  $("editBanner").scrollIntoView({ behavior: "smooth", block: "center" });
}
function cancelEdit() { state.editingId = null; state.editParentKey = null; clearInputs(); refresh(); }
// 辺の途中から（v13.9）の欄: 接続するときだけ出す。起点のボタンには辺の両端の頂点名を出す
function refreshPartialUi() {
  const locked = baseLocked(), edge = lockedEdge(), vertices = vertexList(state.shapes);
  $("partialToggle").closest(".partial-toggle").classList.toggle("hidden", !locked);
  $("partialPanel").classList.toggle("hidden", !partialOn());
  if (edge) { $("partialFromA").textContent = `${vertexNameOf(edge.a, vertices)} から`; $("partialFromB").textContent = `${vertexNameOf(edge.b, vertices)} から`; }
}
function refresh() {
  const has = state.shapes.length > 0, editing = editingShape(), locked = baseLocked();
  const editNo = editing ? state.shapes.indexOf(editing) + 1 : 0;
  $("connectionPanel").classList.toggle("hidden", !has || (!!editing && !editing.parent));
  // 修正中は「差し替え」として、つなぐ辺を選び直せる
  $("connectionPanel").querySelector(".section-label").textContent = editing ? "接続する辺（差し替えるときは選び直す）" : "1. 接続する辺を選択";
  $("flipField").classList.toggle("hidden", !locked);
  $("stepNumber").textContent = has && (!editing || editing.parent) ? "2" : "1";
  $("stepNumber").parentElement.lastChild.textContent = editing ? ". 図形の種類と寸法" : ". 追加する図形";
  refreshPartialUi();
  const part = partialOn(); // 辺の途中から（v13.9）は、底辺を手で入れる
  $("sideC").readOnly = locked && !part; $("bottomBase").readOnly = locked && !part;
  const startName = part ? (() => { const e = lockedEdge(), v = vertexList(state.shapes); return e ? vertexNameOf(partialFrom() === "b" ? e.b : e.a, v) : ""; })() : "";
  $("sideCLabel").textContent = part ? `c（${startName} から）` : locked ? "接続辺 c" : "辺 c";
  $("bottomBaseLabel").textContent = part ? `下底（${startName} から）` : locked ? "接続辺（下底）" : "下底";
  $("editBanner").classList.toggle("hidden", !editing);
  $("editBannerText").textContent = editing ? `図形 ${editNo} を修正中（寸法・種類・接続する辺を変えられます）` : "";
  document.querySelectorAll(".mode").forEach(b => b.disabled = false); // 差し替え（v13.2）: 修正中も三角形⇔台形を変えられる
  $("addShapeButton").textContent = editing ? `図形 ${editNo} を修正` : "この図形を追加";
  $("undoButton").disabled = !!editing;
  $("shapeCount").textContent = state.shapes.length;
  $("printButton").disabled = !has;
  $("canvasHint").textContent = editing ? "点線が修正後の位置です" : has ? "緑色の外周辺をタップして次の接続先を選択" : "最初の図形を追加してください";
  refreshEdgeOptions(); applySharedLength(); updateQuickHint(); renderSummary(); renderParts();
  if ($("quickInput").value.trim()) applyQuickInput(); else { $("quickParsed").innerHTML = quickChips([]); updatePreview(); } // 空でも、今の図形で話す寸法の欄（a・b など）を見せる
  saveDraft();
}
function renderSummary() {
  const total = computeTotal(state.shapes), design = designNum();
  $("drawingTotal").textContent = fmt(total);
  const d = designDiff(total, design);
  $("designSummary").classList.toggle("hidden", !d);
  if (d) $("designSummary").innerHTML = `設計 ${fmt(design)} m² ／ 差 <b class="${d.diff > 0 ? "plus" : d.diff < 0 ? "minus" : ""}">${diffText(total, design)}</b>`;
  $("measureTotal").innerHTML = `${state.shapes.length} 図形　合計 <b>${fmt(total)}</b> m²${d ? `　設計比 <span class="${d.diff > 0 ? "plus" : d.diff < 0 ? "minus" : ""}">${diffText(total, design)}</span>` : ""}`;
}

// ---------- 図面を見ながら入力（全画面） ----------
function measureOpen() { return !$("measureOverlay").hidden; }
function focusQuick() { const input = $("quickInput"); if (document.activeElement === input) return; input.focus({ preventScroll: true }); try { input.setSelectionRange(input.value.length, input.value.length); } catch { } }
function syncMeasureTools() {
  refreshPartialUi(); // 辺を選び直したときも、起点のボタンの頂点名を合わせる（v13.9）
  const editing = editingShape(), locked = baseLocked(), edge = lockedEdge();
  $("measureMode").textContent = state.mode === "triangle" ? "△ 三角形" : "▱ 台形";
  $("measureMode").disabled = false;
  $("measureSwap").classList.toggle("hidden", state.mode !== "triangle");
  $("measureFlip").classList.toggle("hidden", !locked);
  $("measureFlip").setAttribute("aria-pressed", String($("flipDirection").checked));
  $("measureUndo").disabled = !state.shapes.length || !!editing;
  $("measureAdd").textContent = editing ? "修正" : "追加";
  const vertices = vertexList(state.shapes);
  const partInfo = partialOn() ? (() => { try { const q = formPart(); return `の途中まで（${q.from === "b" ? vertexNameOf(edge.b, vertices) : vertexNameOf(edge.a, vertices)} から ${fmtLen(q.length)} m）`; } catch { return "の途中"; } })() : "";
  $("measureEdge").textContent = editing ? `図形 ${state.shapes.indexOf(editing) + 1} を修正中` : edge && locked ? `接続辺 ${vertexNameOf(edge.a, vertices)}–${vertexNameOf(edge.b, vertices)}${partInfo}（${fmtLen(dist(edge.a, edge.b))} m）` : "";
  $("measureEdgeBadge").textContent = $("measureEdge").textContent; // 詰めた表示では説明の行を隠し、図面の上に出す
  const zoom = $("measureZoom");
  zoom.classList.toggle("hidden", state.shapes.length < 2);
  zoom.textContent = state.settings.measureZoom ? "全体" : "拡大";
  zoom.setAttribute("aria-pressed", String(state.settings.measureZoom));
}
function layoutMeasure() {
  if (!measureOpen()) return;
  const vv = window.visualViewport, top = vv ? vv.offsetTop : 0, height = vv ? vv.height : window.innerHeight;
  const overlay = $("measureOverlay");
  overlay.style.top = `${top}px`; overlay.style.height = `${height}px`;
  document.documentElement.style.setProperty("--vv-top", `${top}px`);
  document.body.classList.toggle("keyboard-open", window.innerHeight - height > 120);
  // 見える高さが低いとき（キーボード表示中など）は詰めた表示にする。予測変換の欄などで高さが少し変わっても行き来しないよう、540px 未満で詰め、580px 以上で戻す
  const was = overlay.classList.contains("compact"), compact = was ? height < 580 : height < 540;
  if (compact !== was) { overlay.classList.toggle("compact", compact); state.zoom = { key: null, points: [] }; renderCanvas(); } // 入力欄へのフォーカスは触らない
}
function setMeasureKeyboard(kind) {
  state.settings.measureKeyboard = kind; saveSettings();
  $("quickInput").inputMode = kind === "numeric" ? "decimal" : "text";
  $("measureKeyboard").textContent = kind === "numeric" ? "🎙あ" : "123";
  $("measureKeyboard").setAttribute("aria-label", kind === "numeric" ? "音声入力できるキーボードに切り替え" : "数字キーボードに切り替え");
  $("measureNext").classList.toggle("hidden", kind !== "numeric");
  applyNumbersOnly(); // 数字キーボード（手入力）のときは、入力欄の文字をそのまま見せる
}
function openMeasure() {
  if (measureOpen()) return;
  $("measureOverlay").hidden = false;
  document.body.classList.add("measuring");
  if (!history.state?.measure) history.pushState({ measure: true }, "");
  layoutMeasure(); syncMeasureTools(); renderCanvas(true);
  focusQuick();
}
function closeMeasure(fromHistory = false) {
  if (!measureOpen()) return;
  $("measureOverlay").hidden = true;
  document.body.classList.remove("measuring", "keyboard-open");
  $("quickInput").blur();
  if (!fromHistory && history.state?.measure) history.back();
  renderCanvas(true);
}
// 辺の途中から（v13.9）の説明: 「辺 A–B の途中から（A から 1.2 m の点 P、底辺 2.5 m）」
function partLabel(s, shapes, vertices) {
  const q = s.parent?.part; if (!q) return "";
  const parent = shapes.find(x => x.id === s.parent.shapeId); if (!parent) return "";
  const e = edgeOf(parent, s.parent.index), na = vertexNameOf(e.a, vertices), nb = vertexNameOf(e.b, vertices), start = q.from === "b" ? nb : na;
  if (!q.d) return `辺 ${na}–${nb} の途中まで（${start} から ${fmtLen(q.length)} m の点 ${vertexNameOf(partPoint(s), vertices)} まで）`; // v14.0
  return `辺 ${na}–${nb} の途中から（${start} から ${fmtLen(q.d)} m の点 ${vertexNameOf(partPoint(s), vertices)}、底辺 ${fmtLen(q.length)} m）`; // v13.9 の記録
}
function renderParts() {
  const vertices = vertexList(state.shapes);
  $("partsSection").classList.toggle("hidden", !state.shapes.length);
  $("partsList").innerHTML = state.shapes.map((s, i) => {
    const thin = s.type === "triangle" && minAngle(s) < THIN_ANGLE_DEG;
    const closes = (s.close || []).map(c => closeText(c, state.shapes, vertices));
    const partText = partLabel(s, state.shapes, vertices);
    const closeBadge = closes.length ? `<small class="close-badge ${closes.some(c => c.warn) ? "warn" : ""}">◎ ${closes.map(c => `頂点 ${c.name} に閉合（ずれ ${c.gap}）`).join("、")}</small>` : "";
    return `<div class="part-row ${s.id === state.editingId ? "editing" : ""}"><span class="part-number">${i + 1}</span><div><strong>${s.type === "triangle" ? "三角形" : "台形"}${s.type === "trapezoid" ? `・${{ left: "左", center: "中央", right: "右" }[s.alignment]}揃え` : ""}（${shapeVertexText(s, vertices)}）</strong><small>${dimensionText(s)}</small>${partText ? `<small class="part-badge">◇ ${partText}</small>` : ""}${closeBadge}${thin ? `<small class="thin-badge">⚠ 最小角 ${minAngle(s).toFixed(1)}°</small>` : ""}</div><div class="part-area">${fmt(roundArea(s.area))} m²</div><div class="part-buttons"><button type="button" class="part-edit" data-edit-shape="${esc(s.id)}">修正</button><button type="button" class="part-delete" data-delete-shape="${esc(s.id)}" ${state.editingId ? "disabled" : ""}>削除</button></div></div>`;
  }).join("");
}
// 途中の図形を削除する（v13.2）。その図形につながっている先の図形も行き場が無くなるので一緒に削除する（確認してから）
function deleteShape(id) {
  const k = state.shapes.findIndex(s => s.id === id); if (k < 0 || state.editingId) return;
  const drop = descendantsOf(id), nums = state.shapes.map((s, i) => drop.has(s.id) ? i + 1 : null).filter(Boolean);
  drop.add(id);
  const text = nums.length ? `図形 ${k + 1} につながっている図形 ${nums.join("・")} も一緒に削除されます。` : `図形 ${k + 1} を削除します。`;
  ask(`図形 ${k + 1} を削除しますか？`, text, () => {
    const rest = state.shapes.filter(s => !drop.has(s.id));
    // 作り直す（削除した図形の頂点に閉じていた図形は、同じ位置の点を持つ残りの図形に付け替える）
    try { state.shapes = rebuildShapes(rest); } catch { state.shapes = rest; }
    clearInputs(); refresh();
    showToast(nums.length ? `図形 ${[k + 1, ...nums].join("・")} を削除しました` : `図形 ${k + 1} を削除しました`);
  }, "削除する");
}
function dimensionText(s) { const d = s.dimensions; return s.type === "triangle" ? `a ${fmtLen(d.a)}m / b ${fmtLen(d.b)}m / c ${fmtLen(d.c)}m` : `上底 ${fmtLen(d.top)}m / 下底 ${fmtLen(d.bottom)}m / 高さ ${fmtLen(d.height)}m`; }

// ---------- 記録 ----------
function resetDrawing() {
  state.shapes = []; state.selectedEdge = null; state.recordId = null; state.recordBase = null; state.editingId = null;
  $("name").value = ""; $("date").value = today(); $("designArea").value = ""; $("memo").value = "";
  $("saveDrawingButton").textContent = "図面を保存";
  setProjectCollapsed(false); setMode("triangle"); markSaved(); refresh();
}
// 名称・日付・設計面積は一度入れたら見返さないので、1行の要約に畳んで図面を広く使えるようにする
function renderProjectSummary() {
  const name = $("name").value.trim(), date = $("date").value, design = designNum();
  const detail = [date ? date.replaceAll("-", "/") : "", design > 0 ? `設計 ${fmt(design)} m²` : ""].filter(Boolean).join("・");
  $("projectSummaryText").innerHTML = `${name ? `<b>${esc(name)}</b>` : '<em>名称未入力</em>'}${detail ? `<small>${esc(detail)}</small>` : ""}`;
}
function setProjectCollapsed(on) {
  state.settings.projectCollapsed = on; saveSettings();
  $("projectCard").classList.toggle("collapsed", on);
  $("projectExpand").setAttribute("aria-expanded", String(!on));
  renderProjectSummary();
}
function ask(title, text, action, acceptLabel = "実行") {
  state.confirmAction = action;
  $("confirmTitle").textContent = title; $("confirmText").textContent = text; $("acceptConfirmButton").textContent = acceptLabel;
  $("confirmDialog").showModal();
}
// recordBase: 開いた（保存した）時点の記録の更新日時。保存するとき、記録がその後に別の内容で変わっていたら（JSON の復元など）確認する
function saveDrawing(force = false) {
  const name = $("name").value.trim();
  if (!name) { showToast("名称・測点名を入力してください"); setProjectCollapsed(false); $("name").focus(); return; }
  if (!state.shapes.length) { showToast("図形を1つ以上追加してください"); return; }
  if (state.editingId) { showToast("図形の修正を確定するか、やめてから保存してください"); return; }
  const now = new Date().toISOString(), design = designNum();
  const record = { id: state.recordId || uid(), name, date: $("date").value || today(), designArea: design > 0 ? design : null, memo: $("memo").value.trim(), shapes: structuredClone(state.shapes), total: computeTotal(state.shapes), rounding: currentRounding(), createdAt: now, updatedAt: now };
  const i = state.records.findIndex(r => r.id === record.id), next = [...state.records];
  if (i >= 0 && !force && state.recordBase !== null && next[i].updatedAt !== state.recordBase) { // 更新日時が空の記録も比べる
    ask("保存履歴の図面が変わっています", "開いた後で、保存履歴のこの図面が別の内容に置き換わりました（JSON からの復元など）。今の画面の内容で上書きしますか？", () => saveDrawing(true), "上書きする");
    return;
  }
  if (i >= 0) { record.createdAt = next[i].createdAt; next[i] = record; } else next.unshift(record);
  if (!persist(next)) return;
  state.recordId = record.id; state.recordBase = record.updatedAt; markSaved(); saveDraft(); renderHistory();
  $("saveDrawingButton").textContent = "変更を保存";
  showToast(i >= 0 ? "図面を更新しました" : "図面を保存しました");
}
function editRecord(id) {
  const r = state.records.find(x => x.id === id); if (!r) return;
  state.recordId = r.id; state.recordBase = r.updatedAt; state.editingId = null; state.shapes = withConnections(structuredClone(r.shapes));
  $("name").value = r.name; $("date").value = r.date; $("designArea").value = r.designArea ? fmtLen(r.designArea) : ""; $("memo").value = r.memo || "";
  $("saveDrawingButton").textContent = "変更を保存";
  state.selectedEdge = null; clearInputs(); markSaved(); refresh(); renderProjectSummary(); switchView("drawing");
}
// 保存した記録の合計（保存時の丸め方で計算）
function recordTotal(r) { return computeTotal(r.shapes, recordRounding(r)); }
function renderHistory() {
  $("historyCount").textContent = state.records.length;
  $("emptyState").classList.toggle("hidden", state.records.length > 0);
  state.selected = new Set([...state.selected].filter(id => state.records.some(r => r.id === id)));
  $("historyList").innerHTML = state.records.map(r => {
    const ro = recordRounding(r), total = recordTotal(r), diff = diffText(total, r.designArea, ro.digits), id = esc(r.id);
    return `<article class="record selectable ${state.selected.has(r.id) ? "selected" : ""}"><label class="record-check" aria-label="${esc(r.name)}を合計に含める"><input type="checkbox" class="record-checkbox" data-select="${id}" ${state.selected.has(r.id) ? "checked" : ""}></label><div class="record-main"><button type="button" data-edit="${id}"><div class="record-name">${esc(r.name)}</div><div class="record-meta">${esc(r.date)} ｜ ${r.shapes.length}図形${diff ? `<br>設計比 ${diff}` : ""}${r.memo ? `<br>${esc(r.memo)}` : ""}</div></button></div><div><div class="record-area">${fmt(total, ro.digits)} <small>m²</small></div><div class="history-buttons"><button type="button" data-pdf="${id}">PDF</button><button type="button" data-edit="${id}">編集</button><button type="button" class="delete" data-delete="${id}">削除</button></div></div></article>`;
  }).join("");
  renderSelection();
}
// 保存履歴で選んだ図面の合計。各図面の合計（保存時の丸め方で確定した値）を足す
function renderSelection() {
  const picked = state.records.filter(r => state.selected.has(r.id)), bar = $("selectionBar");
  bar.classList.toggle("hidden", !state.records.length);
  $("selectAllButton").textContent = picked.length === state.records.length && picked.length ? "選択を解除" : "すべて選択";
  if (!picked.length) { $("selectionText").innerHTML = "図面にチェックを入れると、合計を表示します"; return; }
  const digits = Math.max(...picked.map(r => recordRounding(r).digits));
  const total = Number(picked.reduce((s, r) => s + recordTotal(r), 0).toFixed(digits));
  const allDesign = picked.every(r => r.designArea > 0), design = picked.reduce((s, r) => s + (r.designArea || 0), 0);
  $("selectionText").innerHTML = `<span>${picked.length}件を選択</span><strong>合計 ${fmt(total, digits)} m²</strong>${allDesign ? `<span>設計 ${fmt(design, digits)} m² ／ 差 ${diffText(total, design, digits)}</span>` : ""}`;
}
function switchView(view) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("drawingView").classList.toggle("active", view === "drawing");
  $("historyView").classList.toggle("active", view === "history");
  if (view === "history") renderHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
// ---------- PDF（v13.8: 既存のソフトの様式に合わせ、寸法・算出根拠の欄は廃止。表は No.・a・b・c・s・面積） ----------
// 合計の根拠（v13.1）: 表の「面積」の列と同じ、丸めた各面積を面積の桁数（既定は小数第3位）で並べる。
// 「合計してから丸め」では、並べた値の和と合計が端数で合わないことがあるので、そのときは「≒」にする
function totalBasis(shapes, ro, total) {
  const parts = shapes.map(s => roundArea(s.area, ro));
  const eq = Math.abs(Number(parts.reduce((x, p) => x + p, 0).toFixed(ro.digits)) - total) < 1e-9 ? "=" : "≒";
  return `合計 = ${parts.map(p => fmt(p, ro.digits)).join(" + ")} ${eq} ${fmt(total, ro.digits)} m²`;
}
// PDF の表（v13.8、既存のソフトの出力様式に合わせる）: No.・a・b・c・s・面積。s = (a + b + c) ÷ 2（ヘロンの公式の S）。
// 長さは小数第3位まで（m）、面積は面積の丸め方で。台形は a・b・c の欄に上底・下底・高さを入れ、s の欄は「台形」
function printLen(v) { return Number(v).toFixed(3); }
function printRow(s, i, ro) {
  const d = s.dimensions;
  const cells = s.type === "triangle"
    ? [printLen(d.a), printLen(d.b), printLen(d.c), printLen((d.a + d.b + d.c) / 2)]
    : [`上底 ${printLen(d.top)}`, `下底 ${printLen(d.bottom)}`, `高さ ${printLen(d.height)}`, "台形"];
  return `<tr><td class="print-no">${i + 1}</td>${cells.map(c => `<td class="print-num">${c}</td>`).join("")}<td class="print-area">${fmt(roundArea(s.area, ro), ro.digits)}</td></tr>`;
}
function printRecord(record = null) {
  const design = designNum();
  const r = record || { name: $("name").value.trim() || "未保存の図面", date: $("date").value || today(), designArea: design > 0 ? design : null, memo: $("memo").value.trim(), shapes: state.shapes };
  if (!r.shapes.length) return;
  const ro = record ? recordRounding(record) : currentRounding(); // 保存した記録は保存時の丸め方で出す
  const viewBox = viewBoxFor(r.shapes.flatMap(s => s.points)), vertices = vertexList(r.shapes), total = computeTotal(r.shapes, ro), diff = diffText(total, r.designArea, ro.digits);
  // A4 縦に収めるため、図形が多いほど図面を低くする（v13.8: 表が1図形1行になったので、110mm から1行ごとに 6.5mm 低くし、60mm まで）
  const svgHeight = Math.max(60, Math.min(110, 180 - 6.5 * r.shapes.length));
  // 閉合の記録（v13.3〜）: 閉じた図形があるときだけ、表の下に1行ずつ出す
  const partNotes = r.shapes.map((s, i) => { const t = partLabel(s, r.shapes, vertices); return t ? `<div class="print-close part">※ No.${i + 1}：${t}</div>` : ""; }).join(""); // 辺の途中から（v13.9）
  const closeNotes = partNotes + r.shapes.flatMap((s, i) => (s.close || []).map(c => {
    const t = closeText(c, r.shapes, vertices);
    return `<div class="print-close ${t.warn ? "warn" : ""}">${t.warn ? "⚠" : "※"} No.${i + 1}：頂点 ${t.name} に閉合（閉合差 ${t.gap}）。図面は頂点を合わせて描画、面積は実測寸法で計算</div>`;
  })).join("");
  const svg = `<svg class="print-svg" style="height:${svgHeight}mm" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${svgMarkup(r.shapes, { viewBox })}</svg>`;
  $("printSheet").innerHTML = `<h1>現場面積図面</h1><div class="print-meta"><div><b>名称・測点名：</b>${esc(r.name)}</div><div><b>日付：</b>${esc(r.date)}</div></div>${svg}<table class="print-table"><thead><tr><th>No.</th><th>a (m)</th><th>b (m)</th><th>c (m)</th><th>s (m)</th><th>面積 (m²)</th></tr></thead><tbody>${r.shapes.map((s, i) => printRow(s, i, ro)).join("")}</tbody></table>${closeNotes}<div class="print-total">合計面積 ${fmt(total, ro.digits)} m²</div><div class="print-total-basis">${totalBasis(r.shapes, ro, total)}</div>${r.designArea ? `<div class="print-design">設計面積 ${fmt(r.designArea, ro.digits)} m² ／ 差 ${diff}</div>` : ""}<div class="print-rounding">${roundingNote(ro)}</div>${r.memo ? `<div class="print-note"><b>メモ：</b><br>${esc(r.memo)}</div>` : ""}`;
  window.print();
}
function download(name, content, type) { const blob = new Blob([content], { type }), url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 500); }
function csvCell(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }
// 名称・メモが = + - @ などで始まると、表計算ソフトが数式として扱うので、先頭に ' を付けて文字として出す
function csvText(v) { const s = String(v ?? ""); return csvCell(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s); }
function exportCsv() {
  if (!state.records.length) return showToast("出力する記録がありません");
  const head = ["名称・測点名", "日付", "図形数", "合計面積(m²)", "設計面積(m²)", "差(m²)", "比率(%)", "面積の丸め", "メモ"];
  const rows = state.records.map(r => {
    const ro = recordRounding(r), total = recordTotal(r), d = designDiff(total, r.designArea, ro.digits);
    return [csvText(r.name), ...[r.date, r.shapes.length, total.toFixed(ro.digits), r.designArea ?? "", d ? d.diff.toFixed(ro.digits) : "", d ? d.ratio.toFixed(2) : "", roundingText(ro)].map(csvCell), csvText(r.memo)].join(",");
  });
  download(`現場面積_${today()}.csv`, "﻿" + [head.map(csvCell).join(","), ...rows].join("\r\n"), "text/csv;charset=utf-8");
}
function exportJson() { download(`現場面積バックアップ_${today()}.json`, JSON.stringify({ app: "現場面積ノート", version: 3, exportedAt: new Date().toISOString(), records: state.records }, null, 2), "application/json"); }
async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.records)) throw Error();
    const valid = data.records.map(sanitizeRecord).filter(Boolean), skipped = data.records.length - valid.length;
    if (!valid.length) throw Error();
    // 同じ図面が端末にもあるときは、更新日時の新しい方を残す（古いバックアップで、後から直した図面が巻き戻らないように）
    const map = new Map(state.records.map(r => [r.id, r]));
    let kept = 0;
    valid.forEach(r => { const cur = map.get(r.id); if (cur && String(cur.updatedAt) >= String(r.updatedAt)) { kept++; return; } map.set(r.id, r); });
    if (!persist([...map.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))))) return;
    const notes = [kept ? `${kept}件は端末の方が新しいか同じため、端末の内容を残しました` : "", skipped ? `${skipped}件は形式が正しくないため読み込みませんでした` : ""].filter(Boolean);
    renderHistory(); showToast(`${valid.length - kept}件を復元しました${notes.length ? `（${notes.join("。")}）` : ""}`);
  } catch { showToast("このバックアップは読み込めません"); }
  finally { $("importJsonInput").value = ""; }
}
function showToast(text) { const t = $("toast"); t.textContent = text; t.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => t.classList.remove("show"), 2200); }

// ---------- 設定・屋外モード・画面の消灯防止 ----------
function applySettings() {
  document.body.classList.toggle("outdoor", state.settings.outdoor);
  $("outdoorButton").setAttribute("aria-pressed", String(state.settings.outdoor));
  $("setDigits").value = String(state.settings.digits); $("setMethod").value = state.settings.method; $("setSumMode").value = state.settings.sumMode;
  $("setOutdoor").checked = state.settings.outdoor; $("setWakeLock").checked = state.settings.wakeLock; $("setSignalAdd").checked = state.settings.signalAdd; $("setShowRaw").checked = state.settings.showRaw;
  applyNumbersOnly();
}
function changeSetting(key, value) { state.settings[key] = value; saveSettings(); applySettings(); refresh(); renderHistory(); if (key === "wakeLock") updateWakeLock(); }
function renderWakeStatus() {
  $("wakeLockStatus").textContent = !("wakeLock" in navigator) ? "この端末・ブラウザは消灯防止に対応していません。" : state.wakeLock ? "消灯防止は有効です。" : state.settings.wakeLock ? "画面をタップすると有効になります。" : "";
}
async function updateWakeLock() {
  if (!("wakeLock" in navigator)) { renderWakeStatus(); return; }
  const want = state.settings.wakeLock && document.visibilityState === "visible";
  if (want && !state.wakeLock && !state.wakeLockPending) {
    state.wakeLockPending = true;
    try { state.wakeLock = await navigator.wakeLock.request("screen"); state.wakeLock.addEventListener("release", () => { state.wakeLock = null; renderWakeStatus(); }); } catch { }
    state.wakeLockPending = false;
  } else if (!want && state.wakeLock) { try { await state.wakeLock.release(); } catch { } state.wakeLock = null; }
  renderWakeStatus();
}

// ---------- 音声入力（スマホのキーボード音声入力を使う） ----------
function openKeyboardDictation(target) {
  target.focus();
  try { target.setSelectionRange(target.value.length, target.value.length); } catch { }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  showToast("キーボードのマイクを押して話してください");
}
function setupVoiceButtons() {
  document.querySelectorAll(".voice-button").forEach(button => {
    button.hidden = !mobileDevice;
    button.addEventListener("click", () => openKeyboardDictation($(button.dataset.voiceTarget)));
  });
}

// ---------- イベント ----------
setupVoiceButtons();
document.querySelectorAll(".mode").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
$("quickInput").addEventListener("input", e => {
  const prev = state.lastQuick, now = $("quickInput").value;
  logVoice(`入力(${e.inputType || "-"}) +${now.length - prev.length}字: "${now.slice(-40)}"`);
  skipDuplicatedInsert(prev, now);
  applyQuickInput();
});
// 入力欄から離れたら（音声入力が終わったら）、合図で使い終わった文字を消して残りだけにする
$("quickInput").addEventListener("blur", () => {
  if (!state.signal.added || $("confirmDialog").open) return; // 重なりの確認でフォーカスが移ったときは整理しない（確認の後で続きを処理する）
  const rest = activeQuickText().replace(/^[\s、。,.!！?？]+/, "");
  resetSignalSession(); $("quickInput").value = rest; logVoice(`入力欄から離れたので整理: "${rest}"`); applyQuickInput();
});
$("quickInput").addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  if (quickValues().length >= quickTargets().length) addShape();
});
DIMENSION_FIELDS.forEach(id => {
  $(id).addEventListener("input", () => {
    // 寸法を手で直したら、全画面入力に残っている文字は使わない（設定の変更などで古い数字に戻らないように）
    if ($("quickInput").value) { $("quickInput").value = ""; $("quickParsed").innerHTML = quickChips([]); updateQuickNumbers(); resetSignalSession(); state.lastQuick = ""; state.autoError = ""; state.zoom = { key: null, points: [] }; }
    $("message").textContent = ""; updatePreview();
  });
  $(id).addEventListener("change", () => { const v = parseLength($(id).value); if (Number.isFinite(v)) $(id).value = fmtLen(v); updatePreview(); });
});
$("designArea").addEventListener("input", () => { renderSummary(); renderProjectSummary(); saveDraft(); });
["name", "date"].forEach(id => $(id).addEventListener("input", () => { renderProjectSummary(); saveDraft(); }));
$("memo").addEventListener("input", saveDraft);
$("projectCollapse").addEventListener("click", () => setProjectCollapsed(true));
$("projectExpand").addEventListener("click", () => setProjectCollapsed(false));
$("designArea").addEventListener("change", () => { const v = designNum(); if (Number.isFinite(v)) $("designArea").value = fmtLen(v); renderSummary(); saveDraft(); });
document.querySelectorAll('input[name="alignment"]').forEach(r => r.addEventListener("change", updatePreview));
$("flipDirection").addEventListener("change", updatePreview);
$("swapButton").addEventListener("click", swapAB);
$("cancelEditButton").addEventListener("click", cancelEdit);
// 辺の途中から（v13.9）
// チェックを入れたら c（下底）を空にして、起点から測った長さを入れてもらう
$("partialToggle").addEventListener("change", () => { if ($("partialToggle").checked) { $("sideC").value = ""; $("bottomBase").value = ""; } refresh(); });
document.querySelectorAll('input[name="partialFrom"]').forEach(r => r.addEventListener("change", () => refresh()));
$("edgeSelect").addEventListener("change", e => { selectEdge(e.target.value); applySharedLength(); updatePreview(); });
$("drawingCanvas").addEventListener("click", e => {
  const hit = e.target.closest("[data-edge]"); if (!hit || !selectEdge(hit.dataset.edge)) return;
  refreshEdgeOptions(); applySharedLength(); updatePreview(); showToast(state.editingId ? "つなぎ直す辺を選択しました" : "接続辺を選択しました");
});
$("partsList").addEventListener("click", e => {
  const edit = e.target.closest("[data-edit-shape]"), del = e.target.closest("[data-delete-shape]");
  if (edit) startEdit(edit.dataset.editShape);
  if (del) deleteShape(del.dataset.deleteShape);
});
// プレビューの「閉じない／閉じる」（全画面ではキーボードを閉じないよう、入力欄のフォーカスはそのまま）
["previewBox", "measureStatus"].forEach(id => $(id).addEventListener("click", e => {
  const add = e.target.closest("[data-close-add]");
  if (add) { // 合図で追加しようとして閉じる候補が見つかったときの選択（v13.3）
    state.noClose = add.dataset.closeAdd === "open"; state.closeHold = false;
    addShape({ closeChosen: true });
    return;
  }
  if (!e.target.closest("[data-close-toggle]")) return;
  state.noClose = !state.noClose; updatePreview();
}));
$("fitButton").addEventListener("click", () => renderCanvas(true));
$("addShapeButton").addEventListener("click", addShape);
$("undoButton").addEventListener("click", undoLast);
$("openMeasureButton").addEventListener("click", openMeasure);
$("openMeasureTool").addEventListener("click", openMeasure);
$("measureClose").addEventListener("click", () => closeMeasure());
$("measureMode").addEventListener("click", () => { setMode(state.mode === "triangle" ? "trapezoid" : "triangle"); focusQuick(); });
$("measureSwap").addEventListener("click", () => { swapAB(); focusQuick(); });
$("measureFlip").addEventListener("click", () => { $("flipDirection").checked = !$("flipDirection").checked; updatePreview(); focusQuick(); });
$("measureUndo").addEventListener("click", undoLast);
$("measureAdd").addEventListener("click", () => { addShape(); if (measureOpen() && !$("confirmDialog").open) focusQuick(); });
$("measureNext").addEventListener("click", () => { const input = $("quickInput"); if (input.value.trim()) { input.value = input.value.trimEnd() + " "; applyQuickInput(); } focusQuick(); });
$("measureKeyboard").addEventListener("click", () => { setMeasureKeyboard(state.settings.measureKeyboard === "numeric" ? "voice" : "numeric"); $("quickInput").blur(); focusQuick(); });
$("measureCanvas").addEventListener("click", e => {
  const hit = e.target.closest("[data-edge]"); if (!hit || !selectEdge(hit.dataset.edge)) return;
  refreshEdgeOptions(); applySharedLength(); updateQuickHint();
  if ($("quickInput").value.trim()) applyQuickInput(); else updatePreview();
  showToast(state.editingId ? "つなぎ直す辺を選択しました" : "接続辺を選択しました");
});
// 全画面のボタンや図面を押してもキーボードが閉じないよう、入力欄からフォーカスを外さない
$("measureOverlay").addEventListener("mousedown", e => { if (e.target !== $("quickInput")) e.preventDefault(); });
if (history.state?.measure) history.replaceState(null, ""); // 再読み込み後に全画面の履歴が残らないように
window.addEventListener("popstate", () => closeMeasure(true));
if (window.visualViewport) { visualViewport.addEventListener("resize", layoutMeasure); visualViewport.addEventListener("scroll", layoutMeasure); }
window.addEventListener("resize", layoutMeasure);
$("newButton").addEventListener("click", () => isDirty() ? ask("新しい図面を作りますか？", "保存していない変更は失われます。", resetDrawing) : resetDrawing());
$("saveDrawingButton").addEventListener("click", () => saveDrawing());
$("printButton").addEventListener("click", () => printRecord());
$("historyList").addEventListener("click", e => {
  const edit = e.target.closest("[data-edit]"), del = e.target.closest("[data-delete]"), pdf = e.target.closest("[data-pdf]");
  // 作図中の図面に保存していない変更があるときは、別の図面で置き換える前に確認する
  if (edit) { const id = edit.dataset.edit; if (isDirty()) ask("作業中の図面を閉じますか？", "連続図面に、保存していない変更があります。この図面を開くと、その変更は失われます。", () => editRecord(id), "閉じて開く"); else editRecord(id); }
  if (pdf) { const r = state.records.find(x => x.id === pdf.dataset.pdf); if (r) printRecord(r); }
  if (del) ask("図面を削除しますか？", "削除した図面は元に戻せません。", () => {
    const id = del.dataset.delete;
    if (!persist(state.records.filter(r => r.id !== id))) return;
    // 連続図面で開いている図面を消したときは、画面の内容を「まだ保存していない新しい図面」として扱う（保存済みのつもりで消えないように）
    if (state.recordId === id) { state.recordId = null; state.recordBase = null; state.savedSnapshot = ""; $("saveDrawingButton").textContent = "図面を保存"; saveDraft(); }
    renderHistory(); showToast("図面を削除しました");
  });
});
$("historyList").addEventListener("change", e => {
  const box = e.target.closest("[data-select]"); if (!box) return;
  if (box.checked) state.selected.add(box.dataset.select); else state.selected.delete(box.dataset.select);
  box.closest(".record").classList.toggle("selected", box.checked);
  renderSelection();
});
$("selectAllButton").addEventListener("click", () => {
  const all = state.records.length && state.records.every(r => state.selected.has(r.id));
  state.selected = all ? new Set() : new Set(state.records.map(r => r.id));
  renderHistory();
});
$("cancelConfirmButton").addEventListener("click", () => $("confirmDialog").close());
$("acceptConfirmButton").addEventListener("click", () => { const fn = state.confirmAction; $("confirmDialog").close(); state.confirmAction = null; if (fn) fn(); });
$("exportCsvButton").addEventListener("click", exportCsv);
$("exportJsonButton").addEventListener("click", exportJson);
$("importJsonInput").addEventListener("change", e => e.target.files[0] && importJson(e.target.files[0]));
$("settingsButton").addEventListener("click", () => { renderWakeStatus(); $("voiceLog").textContent = state.voiceLog.join("\n") || "（まだ記録はありません）"; $("settingsDialog").showModal(); });
$("copyVoiceLog").addEventListener("click", async () => { try { await navigator.clipboard.writeText(state.voiceLog.join("\n")); showToast("記録をコピーしました"); } catch { showToast("コピーできませんでした。画面を撮影してください"); } });
$("closeSettingsButton").addEventListener("click", () => $("settingsDialog").close());
$("outdoorButton").addEventListener("click", () => changeSetting("outdoor", !state.settings.outdoor));
$("setDigits").addEventListener("change", e => changeSetting("digits", Number(e.target.value)));
$("setMethod").addEventListener("change", e => changeSetting("method", e.target.value));
$("setSumMode").addEventListener("change", e => changeSetting("sumMode", e.target.value));
$("setOutdoor").addEventListener("change", e => changeSetting("outdoor", e.target.checked));
$("setWakeLock").addEventListener("change", e => changeSetting("wakeLock", e.target.checked));
$("setSignalAdd").addEventListener("change", e => changeSetting("signalAdd", e.target.checked));
$("setShowRaw").addEventListener("change", e => changeSetting("showRaw", e.target.checked));
$("measureZoom").addEventListener("click", () => { toggleMeasureZoom(); focusQuick(); });
document.addEventListener("visibilitychange", updateWakeLock);
document.addEventListener("pointerdown", () => { if (state.settings.wakeLock && !state.wakeLock) updateWakeLock(); }, { passive: true });
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); state.deferredInstall = e; $("installButton").classList.remove("hidden"); });
$("installButton").addEventListener("click", async () => { if (!state.deferredInstall) return; state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall = null; $("installButton").classList.add("hidden"); });
// ---------- アプリの更新のお知らせ（v13.4） ----------
// GitHub Pages を更新しても、開いている画面は古い版のまま動く。Service Worker が新しい版で有効になったら版を知らせてくるので、
// この画面の版と違えば「新しい版があります」を出す。作業中の図面があっても勝手には再読み込みしない（押したときだけ）
function appVersion() { return (document.querySelector(".app-version")?.textContent || "").replace(/^ver\./, "").trim(); }
function showUpdateBanner(version) {
  if (!version || version === appVersion() || state.updateDismissed === version) return;
  state.updateVersion = version;
  $("updateText").textContent = `新しい版（ver.${version}）があります。図面を保存してから再読み込みしてください`;
  $("updateBanner").classList.remove("hidden");
}
function reloadForUpdate() {
  if (!isDirty()) { location.reload(); return; }
  ask("新しい版に切り替えますか？", "保存していない図面は下書きとして残り、再読み込みの後に戻ります。確実にするなら、先に「図面を保存」してください。", () => { saveDraft(); location.reload(); }, "再読み込み");
}
$("updateReload").addEventListener("click", reloadForUpdate);
$("updateClose").addEventListener("click", () => { state.updateDismissed = state.updateVersion; $("updateBanner").classList.add("hidden"); });
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", e => { if (e.data?.type === "version") showUpdateBanner(String(e.data.version)); });
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./service-worker.js");
      navigator.serviceWorker.controller?.postMessage({ type: "version?" }); // 起動時に、今動いている Service Worker の版を尋ねる
      // ホーム画面のアプリは開きっぱなしのことが多いので、画面に戻ったときに新しい版が無いか確かめる
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => { }); });
    } catch { }
  });
}
$("date").value = today();
const draftRestored = restoreDraft(); // refresh より前に戻す（refresh が空の図面で下書きを消さないように）
if (!draftRestored) markSaved();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveDraft(); });
window.addEventListener("pagehide", saveDraft);
applySettings(); setMeasureKeyboard(state.settings.measureKeyboard); setProjectCollapsed(state.settings.projectCollapsed); updateQuickHint(); refresh(); renderHistory(); updateWakeLock();
function showLoadProblem() {
  if (loadRecords.rejected === "storage") showToast("端末の保存領域を使えません（プライベートブラウズなど）。図面は「PDF出力」で残してください");
  else if (loadRecords.rejected) showToast(`${loadRecords.rejected === "all" ? "保存データを読み込めませんでした" : `読み込めない記録が${loadRecords.rejected}件ありました`}${loadRecords.backupFailed ? "（空き容量が足りず、元のデータを残せませんでした）" : "（元のデータは別に残しています）"}`);
}
if (draftRestored) showToast("保存していない作業中の図面を戻しました（不要なら「新規」を押してください）");
if (loadRecords.rejected) setTimeout(showLoadProblem, draftRestored ? 2400 : 0); // 下書きのお知らせと重ならないように後から出す
