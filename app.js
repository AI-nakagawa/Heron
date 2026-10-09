"use strict";
const STORAGE_KEY = "field-area-drawings-v2", SETTINGS_KEY = "field-area-settings-v1";
const THIN_ANGLE_DEG = 20; // これより小さい角を持つ三角形は警告する
const DEFAULT_SETTINGS = { digits: 3, method: "round", sumMode: "total", outdoor: false, wakeLock: true, measureKeyboard: "voice", projectCollapsed: false, signalAdd: true };
const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const state = { mode: "triangle", shapes: [], selectedEdge: null, recordId: null, editingId: null, candidate: null, records: loadRecords(), settings: loadSettings(), confirmAction: null, deferredInstall: null, viewBox: "0 0 700 430", wakeLock: null, wakeLockPending: false, signal: { needs: [], added: 0, barrier: null }, lastQuick: "", voiceLog: [], selected: new Set() };
const FIELD_LABELS = { sideA: "a", sideB: "b", sideC: "c", topBase: "上底", bottomBase: "下底", height: "高さ" };
const DIMENSION_FIELDS = Object.keys(FIELD_LABELS);
const mobileDevice = /Android|iPad|iPhone|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 0;

// ---------- 共通 ----------
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function esc(v) { return String(v ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function num(id) { return parseLength($(id).value); }
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
function designDiff(total, design, digits = state.settings.digits) {
  if (!(design > 0)) return null;
  const diff = Number((total - design).toFixed(digits));
  return { diff, ratio: diff / design * 100 };
}
function diffText(total, design, digits = state.settings.digits) {
  const d = designDiff(total, design, digits); if (!d) return "";
  const sign = d.diff > 0 ? "+" : d.diff < 0 ? "−" : "±";
  return `${sign}${fmt(Math.abs(d.diff), digits)} m²（${sign}${Math.abs(d.ratio).toFixed(2)}%）`;
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
function freeEdges(shapes = state.shapes) { const all = shapes.flatMap(shapeEdges); return all.filter((e, i) => !all.some((o, j) => j !== i && sameEdge(e.a, e.b, o.a, o.b))); }
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
// 接続関係と寸法から図面全体を作り直す（途中の図形を修正したとき）
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
    try { shape = buildShape(spec, edge, built); }
    catch (e) { throw Error(`図形 ${i + 1} が成り立たなくなります：${e.message}`); }
    shape.id = spec.id;
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
  if (!keys.every(k => isNum(d[k]) && d[k] > 0) || !isNum(s.area) || s.area < 0) return null;
  const alignment = s.type === "trapezoid" ? s.alignment : null;
  if (s.type === "trapezoid" && !["left", "center", "right"].includes(alignment)) return null;
  const out = { id: s.id, type: s.type, points: s.points.map(p => ({ x: p.x, y: p.y })), area: s.area, dimensions: Object.fromEntries(keys.map(k => [k, d[k]])), alignment };
  if ("parent" in s) { // 無い場合（v10 まで）は withConnections で点の位置から復元する
    const p = s.parent;
    if (p !== null && !(p && isId(p.shapeId) && Number.isInteger(p.index) && p.index >= 0 && p.index < 4)) return null;
    out.parent = p ? { shapeId: p.shapeId, index: p.index } : null; out.flip = s.flip === true;
  }
  return out;
}
function sanitizeRecord(r) {
  if (!r || typeof r !== "object" || !isId(r.id) || typeof r.name !== "string" || !r.name.trim()) return null;
  if (!Array.isArray(r.shapes) || !r.shapes.length || r.shapes.length > 1000) return null;
  const shapes = r.shapes.map(sanitizeShape);
  if (shapes.some(s => !s)) return null;
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
    if (records.length < v.length) localStorage.setItem(BACKUP_KEY, raw);
    return records;
  } catch {
    try { if (raw) localStorage.setItem(BACKUP_KEY, raw); } catch { }
    return [];
  }
}
function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records)); }
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
function svgMarkup(shapes, { viewBox, selectedEdge = null, ghost = null, interactive = false, textScale = 1 }) {
  if (!shapes.length && !ghost) return '<text x="350" y="205" text-anchor="middle" fill="#829189" font-size="18">ここに連続図面が表示されます</text><text x="350" y="235" text-anchor="middle" fill="#9aa69f" font-size="12">寸法を入力して最初の図形を追加</text>';
  const vb = viewBox.split(/\s+/).map(Number), scale = Math.max(vb[2], vb[3]);
  const t = scale * textScale, labelSize = t * .045, edgeSize = t * .025, labelOffset = t * .012, halo = t * .006, vertexSize = t * .03;
  const all = ghost ? [...shapes, ghost] : shapes, vertices = vertexList(all), center = centroid(all.flatMap(s => s.points));
  let html = "";
  const labeled = [];
  shapes.forEach((s, i) => {
    const c = centroid(s.points);
    html += `<polygon class="shape-polygon" points="${s.points.map(p => `${p.x},${p.y}`).join(" ")}" fill="${color(i)}" fill-opacity=".78"/><text class="shape-label" style="font-size:${labelSize}px" x="${c.x}" y="${c.y}">${i + 1}</text>`;
    shapeEdges(s).forEach(e => {
      if (labeled.some(o => sameEdge(e.a, e.b, o.a, o.b))) return;
      labeled.push(e);
      const m = midpoint(e.a, e.b);
      html += `<text class="edge-length" style="font-size:${edgeSize}px;stroke-width:${halo}px" x="${m.x}" y="${m.y - labelOffset}">${dist(e.a, e.b).toFixed(2)}m</text>`;
    });
  });
  if (interactive) freeEdges(shapes).forEach(e => {
    const key = edgeKey(e);
    html += `<line class="edge-line ${selectedEdge === key ? "selected" : ""}" x1="${e.a.x}" y1="${e.a.y}" x2="${e.b.x}" y2="${e.b.y}"/><line class="edge-hit" data-edge="${esc(key)}" x1="${e.a.x}" y1="${e.a.y}" x2="${e.b.x}" y2="${e.b.y}"/>`;
  });
  if (ghost) {
    const gc = centroid(ghost.points);
    html += `<polygon class="ghost-polygon" points="${ghost.points.map(p => `${p.x},${p.y}`).join(" ")}"/>`;
    const names = ghost.type === "triangle" ? ["c", "a", "b"] : ["下底", null, "上底", null];
    shapeEdges(ghost).forEach((e, i) => {
      if (!names[i] || (i === 0 && ghost.parent)) return; // 接続辺は既存の長さ表示と重なるので出さない
      const m = midpoint(e.a, e.b), dx = m.x - gc.x, dy = m.y - gc.y, l = Math.hypot(dx, dy) || 1;
      html += `<text class="ghost-label" style="font-size:${edgeSize * 1.15}px;stroke-width:${halo}px" x="${m.x + dx / l * edgeSize * 1.6}" y="${m.y + dy / l * edgeSize * 1.6}">${names[i]} ${fmtLen(dist(e.a, e.b))}</text>`;
    });
  }
  vertices.forEach(v => {
    const dx = v.x - center.x, dy = v.y - center.y, l = Math.hypot(dx, dy) || 1;
    html += `<circle class="vertex-dot" cx="${v.x}" cy="${v.y}" r="${t * .006}"/><text class="vertex-label" style="font-size:${vertexSize}px;stroke-width:${halo}px" x="${v.x + dx / l * vertexSize}" y="${v.y + dy / l * vertexSize}">${v.name}</text>`;
  });
  return html;
}
function renderCanvas(autoFit = false) {
  if (autoFit) fitView();
  const opts = { selectedEdge: state.editingId ? null : state.selectedEdge, ghost: state.candidate?.shape, interactive: !state.editingId };
  const svg = $("drawingCanvas");
  svg.setAttribute("viewBox", state.viewBox); svg.innerHTML = svgMarkup(state.shapes, { ...opts, viewBox: state.viewBox });
  if (measureOpen()) {
    // 全画面は図面が小さくなりやすいので、余白を詰めて文字を大きめに描く
    const ghost = state.candidate?.shape, viewBox = viewBoxFor([...state.shapes, ...(ghost ? [ghost] : [])].flatMap(s => s.points), .12);
    const big = $("measureCanvas"); big.setAttribute("viewBox", viewBox); big.innerHTML = svgMarkup(state.shapes, { ...opts, viewBox, textScale: 1.6 });
  }
}

// ---------- 入力フォーム ----------
function editingShape() { return state.editingId ? state.shapes.find(s => s.id === state.editingId) : null; }
function baseLocked() { const editing = editingShape(); return editing ? !!editing.parent : state.shapes.length > 0; }
function lockedEdge() {
  const editing = editingShape();
  if (editing) { if (!editing.parent) return null; const p = state.shapes.find(s => s.id === editing.parent.shapeId); return p ? edgeOf(p, editing.parent.index) : null; }
  return state.shapes.length ? edgeByKey(state.selectedEdge) : null;
}
function refreshEdgeOptions() {
  const edges = freeEdges(), vertices = vertexList(state.shapes);
  if (!edges.length) { state.selectedEdge = null; $("edgeSelect").innerHTML = ""; return; }
  if (!edges.some(e => edgeKey(e) === state.selectedEdge)) state.selectedEdge = edgeKey(edges[0]);
  $("edgeSelect").innerHTML = edges.map(e => {
    const si = state.shapes.findIndex(s => s.id === e.shapeId) + 1, key = edgeKey(e);
    return `<option value="${esc(key)}" ${key === state.selectedEdge ? "selected" : ""}>${vertexNameOf(e.a, vertices)}–${vertexNameOf(e.b, vertices)}（${dist(e.a, e.b).toFixed(3)} m）・図形 ${si}</option>`;
  }).join("");
}
function applySharedLength() {
  const edge = lockedEdge(); if (!edge || !baseLocked()) return;
  const l = fmtLen(dist(edge.a, edge.b));
  $("sideC").value = l; $("bottomBase").value = l;
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
function signalGroups(text, limit = Infinity) {
  const signals = findSignals(text), barrier = state.signal.barrier;
  let groups = [], rest = 0, from = 0;
  if (barrier) { // 区切りまでの文字はすべて使い終わった扱い
    groups = new Array(barrier.groups).fill(null);
    from = Math.min(barrier.signals, signals.length);
    rest = from ? signals[from - 1].end : 0;
  }
  for (const sig of signals.slice(from)) {
    if (groups.length >= limit) break;
    const need = state.signal.needs[groups.length] ?? quickTargets().length;
    const values = parseLengths(text.slice(rest, sig.index));
    if (values.length < need) continue; // 1つ目の数字の後の合図などは、次の数字を待つ
    groups.push(values.slice(0, need)); rest = sig.end;
  }
  return { groups, rest };
}
// 使い終わったまとまりより後ろの文字（今の図形の寸法）
function activeQuickText() {
  const text = $("quickInput").value;
  return state.signal.added ? text.slice(signalGroups(text, state.signal.added).rest) : text;
}
// 新しくそろったまとまりがあれば図形を追加する。追加したら true
function processSignals() {
  if (!state.settings.signalAdd) return false;
  const k = state.signal.added, { groups } = signalGroups($("quickInput").value, k + 1);
  if (groups.length <= k) return false;
  const targets = quickTargets(), values = groups[k];
  state.signal.needs[k] = targets.length; state.signal.added = k + 1;
  targets.forEach((id, i) => { $(id).value = fmtLen(values[i]); });
  logVoice(`合図で追加: ${values.map(fmtLen).join(" ")}`);
  if (addShape({ auto: true })) return true;
  DIMENSION_FIELDS.forEach(id => { if (!$(id).readOnly) $(id).value = ""; }); // 追加できなかった寸法は捨てて、読み直しを待つ
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
function applyQuickInput() {
  const text = $("quickInput").value, targets = quickTargets();
  if (!text.trim()) { resetSignalSession(); state.lastQuick = text; $("quickParsed").innerHTML = ""; updatePreview(); return; }
  if (processSignals()) { state.lastQuick = $("quickInput").value; return; }
  state.lastQuick = text;
  const values = parseLengths(activeQuickText());
  targets.forEach((id, i) => { $(id).value = values[i] !== undefined ? fmtLen(values[i]) : ""; });
  const chips = targets.map((id, i) => `<span class="chip ${values[i] === undefined ? "empty" : ""}">${FIELD_LABELS[id]} ${values[i] !== undefined ? fmtLen(values[i]) : "—"}</span>`).join("");
  let status;
  if (values.length < targets.length) status = `<span class="quick-status">あと${targets.length - values.length}つ</span>`;
  else if (values.length > targets.length) status = `<span class="quick-status warn">数が${values.length}個あります。最初の${targets.length}個を使います</span>`;
  else status = `<span class="quick-status ok">✓ そろいました（${state.settings.signalAdd ? "「はい」「OK」" : "改行キー"}か「追加」で追加）</span>`;
  $("quickParsed").innerHTML = chips + status;
  updatePreview();
}
function buildCandidate() {
  const editing = editingShape(), edge = lockedEdge(), flip = $("flipDirection").checked;
  if (!editing && state.shapes.length && !edge) throw Error("接続する辺を選択してください。");
  const spec = state.mode === "triangle"
    ? { type: "triangle", dimensions: { a: num("sideA"), b: num("sideB"), c: num("sideC") }, flip }
    : { type: "trapezoid", dimensions: { top: num("topBase"), bottom: num("bottomBase"), height: num("height") }, alignment: alignment(), flip };
  const shape = buildShape(spec, edge, state.shapes);
  const warnings = [];
  let rebuilt = null;
  if (editing) {
    shape.id = editing.id;
    rebuilt = rebuildShapes(state.shapes.map(s => s.id === editing.id ? shape : s));
  }
  if (shape.type === "triangle") {
    const m = minAngle(shape);
    if (m < THIN_ANGLE_DEG) warnings.push({ text: `最小角が ${m.toFixed(1)}° の細長い三角形です。テープの数cmの誤差が面積に大きく響くため、分け方の見直しや再計測を検討してください。`, short: `細長い三角形（最小角 ${m.toFixed(1)}°）` });
  }
  const hits = overlappingNumbers(shape, state.shapes.filter(s => s.id !== editing?.id));
  if (hits.length) warnings.push({ text: `図形 ${hits.join("・")} と重なっています。「接続方向を反転する」や a・b の入れ替えを確認してください。`, short: `図形 ${hits.join("・")} と重なり（反転・a⇄b を確認）` });
  return { shape, warnings, overlap: hits.length > 0, rebuilt };
}
function updatePreview() {
  const box = $("previewBox"), status = $("measureStatus"), filled = requiredFields().every(id => $(id).value.trim() !== "");
  state.candidate = null;
  if (!filled) {
    box.className = "preview-box idle";
    box.textContent = "寸法を入れると、ここに面積が、図面に点線で追加位置が表示されます。";
    status.className = "measure-status idle";
    status.textContent = state.settings.signalAdd ? "寸法を話し、数がそろったら「はい」「OK」で追加します" : "寸法を話すか入力すると、図面に点線で表示されます（「はい」「OK」などの合図は無視します）";
  } else {
    try {
      const cand = buildCandidate(); state.candidate = cand;
      const editing = editingShape();
      const area = fmt(roundArea(cand.shape.area)), after = fmt(cand.rebuilt ? computeTotal(cand.rebuilt) : computeTotal([...state.shapes, cand.shape]));
      box.className = `preview-box${cand.warnings.length ? " has-warning" : ""}`;
      box.innerHTML = `<div class="preview-line"><span>${editing ? "修正後の図形" : "この図形"} <b>${area}</b> m²</span><span>${editing ? "修正後の合計" : "追加後の合計"} <b>${after}</b> m²</span></div>${cand.warnings.map(w => `<p class="warn">⚠ ${esc(w.text)}</p>`).join("")}`;
      status.className = "measure-status";
      status.innerHTML = `${editing ? "修正後" : "この図形"} <b>${area}</b> m² → 合計 <b>${after}</b> m²${cand.warnings.map(w => `<span class="warn">⚠ ${esc(w.short)}</span>`).join("")}`;
    } catch (e) {
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
  $("quickInput").value = ""; $("quickParsed").innerHTML = ""; resetSignalSession(); state.lastQuick = "";
  $("flipDirection").checked = false;
  document.querySelector('input[name="alignment"][value="center"]').checked = true;
  $("message").textContent = "";
  applySharedLength();
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode").forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle("active", on); b.setAttribute("aria-checked", String(on)); });
  $("triangleFields").classList.toggle("hidden", mode !== "triangle");
  $("trapezoidFields").classList.toggle("hidden", mode !== "trapezoid");
  clearInputs(); updateQuickHint(); updatePreview();
}
function swapAB() {
  const values = parseLengths(activeQuickText());
  if (values.length >= 2) {
    [values[0], values[1]] = [values[1], values[0]];
    $("quickInput").value = values.map(fmtLen).join(" "); resetSignalSession();
    applyQuickInput();
  } else {
    const a = $("sideA").value; $("sideA").value = $("sideB").value; $("sideB").value = a;
    updatePreview();
  }
  showToast("a と b を入れ替えました");
}
function undoLast() {
  ask("最後の図形を戻しますか？", "最後に追加した図形と、その接続を削除します。", () => { state.shapes.pop(); refresh(); showToast("最後の図形を戻しました"); if (measureOpen()) focusQuick(); });
}

// ---------- 図形の追加・修正 ----------
// auto: 合図で追加したとき。音声入力の最中なので入力欄の文字は書き換えない（iPhone で文字が二重になるのを防ぐ）
function addShape({ auto = false } = {}) {
  let cand;
  try { cand = buildCandidate(); }
  catch (e) { $("message").textContent = e.message; if (auto) showToast(`追加できません：${e.message} 読み直してください`); return false; }
  const editing = editingShape();
  const clearAfterAdd = () => {
    if (!auto) { clearInputs(); return; }
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
      clearAfterAdd(); refresh(); showToast(`図形 ${n} を修正しました`);
    } else {
      state.shapes.push(cand.shape);
      const next = freeEdges().find(e => e.shapeId === cand.shape.id);
      if (next) state.selectedEdge = edgeKey(next);
      clearAfterAdd(); refresh(); showToast(`図形 ${state.shapes.length} を追加しました`);
    }
    if (auto) navigator.vibrate?.(40);
    if (measureOpen()) focusQuick(); else if (!auto) $("quickInput").blur();
  };
  if (cand.overlap) ask("図形が重なっています", `${cand.warnings.at(-1).text}\nこのまま${editing ? "修正" : "追加"}しますか？`, commit, editing ? "修正する" : "追加する");
  else commit();
  return true;
}
function startEdit(id) {
  const shape = state.shapes.find(s => s.id === id); if (!shape) return;
  state.editingId = null; setMode(shape.type); state.editingId = id;
  const d = shape.dimensions;
  if (shape.type === "triangle") { $("sideA").value = fmtLen(d.a); $("sideB").value = fmtLen(d.b); $("sideC").value = fmtLen(d.c); }
  else { $("topBase").value = fmtLen(d.top); $("bottomBase").value = fmtLen(d.bottom); $("height").value = fmtLen(d.height); document.querySelector(`input[name="alignment"][value="${shape.alignment}"]`).checked = true; }
  $("flipDirection").checked = !!shape.flip;
  refresh();
  $("editBanner").scrollIntoView({ behavior: "smooth", block: "center" });
}
function cancelEdit() { state.editingId = null; clearInputs(); refresh(); }
function refresh() {
  const has = state.shapes.length > 0, editing = editingShape(), locked = baseLocked();
  const editNo = editing ? state.shapes.indexOf(editing) + 1 : 0;
  $("connectionPanel").classList.toggle("hidden", !has || !!editing);
  $("flipField").classList.toggle("hidden", !locked);
  $("stepNumber").textContent = has && !editing ? "2" : "1";
  $("sideC").readOnly = locked; $("bottomBase").readOnly = locked;
  $("sideCLabel").textContent = locked ? "接続辺 c" : "辺 c";
  $("bottomBaseLabel").textContent = locked ? "接続辺（下底）" : "下底";
  $("editBanner").classList.toggle("hidden", !editing);
  $("editBannerText").textContent = editing ? `図形 ${editNo} を修正中` : "";
  document.querySelectorAll(".mode").forEach(b => b.disabled = !!editing);
  $("addShapeButton").textContent = editing ? `図形 ${editNo} を修正` : "この図形を追加";
  $("undoButton").disabled = !!editing;
  $("shapeCount").textContent = state.shapes.length;
  $("printButton").disabled = !has;
  $("canvasHint").textContent = editing ? "点線が修正後の位置です" : has ? "緑色の外周辺をタップして次の接続先を選択" : "最初の図形を追加してください";
  refreshEdgeOptions(); applySharedLength(); updateQuickHint(); renderSummary(); renderParts();
  if ($("quickInput").value.trim()) applyQuickInput(); else updatePreview();
}
function renderSummary() {
  const total = computeTotal(state.shapes), design = num("designArea");
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
  const editing = editingShape(), locked = baseLocked(), edge = lockedEdge();
  $("measureMode").textContent = state.mode === "triangle" ? "△ 三角形" : "▱ 台形";
  $("measureMode").disabled = !!editing;
  $("measureSwap").classList.toggle("hidden", state.mode !== "triangle");
  $("measureFlip").classList.toggle("hidden", !locked);
  $("measureFlip").setAttribute("aria-pressed", String($("flipDirection").checked));
  $("measureUndo").disabled = !state.shapes.length || !!editing;
  $("measureAdd").textContent = editing ? "修正" : "追加";
  const vertices = vertexList(state.shapes);
  $("measureEdge").textContent = editing ? `図形 ${state.shapes.indexOf(editing) + 1} を修正中` : edge && locked ? `接続辺 ${vertexNameOf(edge.a, vertices)}–${vertexNameOf(edge.b, vertices)}（${fmtLen(dist(edge.a, edge.b))} m）` : "";
}
function layoutMeasure() {
  if (!measureOpen()) return;
  const vv = window.visualViewport, top = vv ? vv.offsetTop : 0, height = vv ? vv.height : window.innerHeight;
  const overlay = $("measureOverlay");
  overlay.style.top = `${top}px`; overlay.style.height = `${height}px`;
  document.documentElement.style.setProperty("--vv-top", `${top}px`);
  document.body.classList.toggle("keyboard-open", window.innerHeight - height > 120);
}
function setMeasureKeyboard(kind) {
  state.settings.measureKeyboard = kind; saveSettings();
  $("quickInput").inputMode = kind === "numeric" ? "decimal" : "text";
  $("measureKeyboard").textContent = kind === "numeric" ? "🎙あ" : "123";
  $("measureKeyboard").setAttribute("aria-label", kind === "numeric" ? "音声入力できるキーボードに切り替え" : "数字キーボードに切り替え");
  $("measureNext").classList.toggle("hidden", kind !== "numeric");
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
function renderParts() {
  const vertices = vertexList(state.shapes);
  $("partsSection").classList.toggle("hidden", !state.shapes.length);
  $("partsList").innerHTML = state.shapes.map((s, i) => {
    const thin = s.type === "triangle" && minAngle(s) < THIN_ANGLE_DEG;
    return `<div class="part-row ${s.id === state.editingId ? "editing" : ""}"><span class="part-number">${i + 1}</span><div><strong>${s.type === "triangle" ? "三角形" : "台形"}${s.type === "trapezoid" ? `・${{ left: "左", center: "中央", right: "右" }[s.alignment]}揃え` : ""}（${shapeVertexText(s, vertices)}）</strong><small>${dimensionText(s)}</small>${thin ? `<small class="thin-badge">⚠ 最小角 ${minAngle(s).toFixed(1)}°</small>` : ""}</div><div class="part-area">${fmt(roundArea(s.area))} m²</div><button type="button" class="part-edit" data-edit-shape="${esc(s.id)}">修正</button></div>`;
  }).join("");
}
function dimensionText(s) { const d = s.dimensions; return s.type === "triangle" ? `a ${fmtLen(d.a)}m / b ${fmtLen(d.b)}m / c ${fmtLen(d.c)}m` : `上底 ${fmtLen(d.top)}m / 下底 ${fmtLen(d.bottom)}m / 高さ ${fmtLen(d.height)}m`; }

// ---------- 記録 ----------
function resetDrawing() {
  state.shapes = []; state.selectedEdge = null; state.recordId = null; state.editingId = null;
  $("name").value = ""; $("date").value = today(); $("designArea").value = ""; $("memo").value = "";
  $("saveDrawingButton").textContent = "図面を保存";
  setProjectCollapsed(false); setMode("triangle"); refresh();
}
// 名称・日付・設計面積は一度入れたら見返さないので、1行の要約に畳んで図面を広く使えるようにする
function renderProjectSummary() {
  const name = $("name").value.trim(), date = $("date").value, design = num("designArea");
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
function saveDrawing() {
  const name = $("name").value.trim();
  if (!name) { showToast("名称・測点名を入力してください"); setProjectCollapsed(false); $("name").focus(); return; }
  if (!state.shapes.length) { showToast("図形を1つ以上追加してください"); return; }
  if (state.editingId) { showToast("図形の修正を確定するか、やめてから保存してください"); return; }
  const now = new Date().toISOString(), design = num("designArea");
  const record = { id: state.recordId || uid(), name, date: $("date").value || today(), designArea: design > 0 ? design : null, memo: $("memo").value.trim(), shapes: structuredClone(state.shapes), total: computeTotal(state.shapes), rounding: currentRounding(), createdAt: now, updatedAt: now };
  const i = state.records.findIndex(r => r.id === record.id);
  if (i >= 0) { record.createdAt = state.records[i].createdAt; state.records[i] = record; } else state.records.unshift(record);
  state.recordId = record.id; persist(); renderHistory();
  $("saveDrawingButton").textContent = "変更を保存";
  showToast(i >= 0 ? "図面を更新しました" : "図面を保存しました");
}
function editRecord(id) {
  const r = state.records.find(x => x.id === id); if (!r) return;
  state.recordId = r.id; state.editingId = null; state.shapes = withConnections(structuredClone(r.shapes));
  $("name").value = r.name; $("date").value = r.date; $("designArea").value = r.designArea ? fmtLen(r.designArea) : ""; $("memo").value = r.memo || "";
  $("saveDrawingButton").textContent = "変更を保存";
  state.selectedEdge = null; clearInputs(); refresh(); renderProjectSummary(); switchView("drawing");
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
function printRecord(record = null) {
  const design = num("designArea");
  const r = record || { name: $("name").value.trim() || "未保存の図面", date: $("date").value || today(), designArea: design > 0 ? design : null, memo: $("memo").value.trim(), shapes: state.shapes };
  if (!r.shapes.length) return;
  const ro = record ? recordRounding(record) : currentRounding(); // 保存した記録は保存時の丸め方で出す
  const viewBox = viewBoxFor(r.shapes.flatMap(s => s.points)), vertices = vertexList(r.shapes), total = computeTotal(r.shapes, ro), diff = diffText(total, r.designArea, ro.digits);
  const svg = `<svg class="print-svg" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${svgMarkup(r.shapes, { viewBox })}</svg>`;
  $("printSheet").innerHTML = `<h1>現場面積図面</h1><div class="print-meta"><div><b>名称・測点名：</b>${esc(r.name)}</div><div><b>日付：</b>${esc(r.date)}</div></div>${svg}<table><thead><tr><th>No.</th><th>図形</th><th>頂点</th><th>寸法</th><th>面積</th></tr></thead><tbody>${r.shapes.map((s, i) => `<tr><td>${i + 1}</td><td>${s.type === "triangle" ? "三角形" : "台形"}</td><td>${shapeVertexText(s, vertices)}</td><td>${esc(dimensionText(s))}</td><td>${fmt(roundArea(s.area, ro), ro.digits)} m²</td></tr>`).join("")}</tbody></table><div class="print-total">合計面積 ${fmt(total, ro.digits)} m²</div>${r.designArea ? `<div class="print-design">設計面積 ${fmt(r.designArea, ro.digits)} m² ／ 差 ${diff}</div>` : ""}<div class="print-rounding">${roundingNote(ro)}</div>${r.memo ? `<div class="print-note"><b>メモ：</b><br>${esc(r.memo)}</div>` : ""}<footer>現場面積ノート</footer>`;
  window.print();
}
function download(name, content, type) { const blob = new Blob([content], { type }), url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 500); }
function csvCell(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }
function exportCsv() {
  if (!state.records.length) return showToast("出力する記録がありません");
  const head = ["名称・測点名", "日付", "図形数", "合計面積(m²)", "設計面積(m²)", "差(m²)", "比率(%)", "面積の丸め", "メモ"];
  const rows = state.records.map(r => {
    const ro = recordRounding(r), total = recordTotal(r), d = designDiff(total, r.designArea, ro.digits);
    return [r.name, r.date, r.shapes.length, total.toFixed(ro.digits), r.designArea ?? "", d ? d.diff.toFixed(ro.digits) : "", d ? d.ratio.toFixed(2) : "", roundingText(ro), r.memo].map(csvCell).join(",");
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
    const map = new Map(state.records.map(r => [r.id, r]));
    valid.forEach(r => map.set(r.id, r));
    state.records = [...map.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    persist(); renderHistory(); showToast(`${valid.length}件を復元しました${skipped ? `（${skipped}件は形式が正しくないため読み込みませんでした）` : ""}`);
  } catch { showToast("このバックアップは読み込めません"); }
  finally { $("importJsonInput").value = ""; }
}
function showToast(text) { const t = $("toast"); t.textContent = text; t.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => t.classList.remove("show"), 2200); }

// ---------- 設定・屋外モード・画面の消灯防止 ----------
function applySettings() {
  document.body.classList.toggle("outdoor", state.settings.outdoor);
  $("outdoorButton").setAttribute("aria-pressed", String(state.settings.outdoor));
  $("setDigits").value = String(state.settings.digits); $("setMethod").value = state.settings.method; $("setSumMode").value = state.settings.sumMode;
  $("setOutdoor").checked = state.settings.outdoor; $("setWakeLock").checked = state.settings.wakeLock; $("setSignalAdd").checked = state.settings.signalAdd;
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
  if (!state.signal.added) return;
  const rest = activeQuickText().replace(/^[\s、。,.!！?？]+/, "");
  resetSignalSession(); $("quickInput").value = rest; logVoice(`入力欄から離れたので整理: "${rest}"`); applyQuickInput();
});
$("quickInput").addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  if (parseLengths(activeQuickText()).length >= quickTargets().length) addShape();
});
DIMENSION_FIELDS.forEach(id => {
  $(id).addEventListener("input", () => { $("message").textContent = ""; updatePreview(); });
  $(id).addEventListener("change", () => { const v = parseLength($(id).value); if (Number.isFinite(v)) $(id).value = fmtLen(v); updatePreview(); });
});
$("designArea").addEventListener("input", () => { renderSummary(); renderProjectSummary(); });
["name", "date"].forEach(id => $(id).addEventListener("input", renderProjectSummary));
$("projectCollapse").addEventListener("click", () => setProjectCollapsed(true));
$("projectExpand").addEventListener("click", () => setProjectCollapsed(false));
$("designArea").addEventListener("change", () => { const v = parseLength($("designArea").value); if (Number.isFinite(v)) $("designArea").value = fmtLen(v); renderSummary(); });
document.querySelectorAll('input[name="alignment"]').forEach(r => r.addEventListener("change", updatePreview));
$("flipDirection").addEventListener("change", updatePreview);
$("swapButton").addEventListener("click", swapAB);
$("cancelEditButton").addEventListener("click", cancelEdit);
$("edgeSelect").addEventListener("change", e => { state.selectedEdge = e.target.value; applySharedLength(); updatePreview(); });
$("drawingCanvas").addEventListener("click", e => {
  const hit = e.target.closest("[data-edge]"); if (!hit || state.editingId) return;
  state.selectedEdge = hit.dataset.edge; refreshEdgeOptions(); applySharedLength(); updatePreview(); showToast("接続辺を選択しました");
});
$("partsList").addEventListener("click", e => { const b = e.target.closest("[data-edit-shape]"); if (b) startEdit(b.dataset.editShape); });
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
  const hit = e.target.closest("[data-edge]"); if (!hit || state.editingId) return;
  state.selectedEdge = hit.dataset.edge; refreshEdgeOptions(); applySharedLength(); updateQuickHint();
  if ($("quickInput").value.trim()) applyQuickInput(); else updatePreview();
  showToast("接続辺を選択しました");
});
// 全画面のボタンや図面を押してもキーボードが閉じないよう、入力欄からフォーカスを外さない
$("measureOverlay").addEventListener("mousedown", e => { if (e.target !== $("quickInput")) e.preventDefault(); });
if (history.state?.measure) history.replaceState(null, ""); // 再読み込み後に全画面の履歴が残らないように
window.addEventListener("popstate", () => closeMeasure(true));
if (window.visualViewport) { visualViewport.addEventListener("resize", layoutMeasure); visualViewport.addEventListener("scroll", layoutMeasure); }
window.addEventListener("resize", layoutMeasure);
$("newButton").addEventListener("click", () => state.shapes.length ? ask("新しい図面を作りますか？", "未保存の変更は失われます。", resetDrawing) : resetDrawing());
$("saveDrawingButton").addEventListener("click", saveDrawing);
$("printButton").addEventListener("click", () => printRecord());
$("historyList").addEventListener("click", e => {
  const edit = e.target.closest("[data-edit]"), del = e.target.closest("[data-delete]"), pdf = e.target.closest("[data-pdf]");
  if (edit) editRecord(edit.dataset.edit);
  if (pdf) { const r = state.records.find(x => x.id === pdf.dataset.pdf); if (r) printRecord(r); }
  if (del) ask("図面を削除しますか？", "削除した図面は元に戻せません。", () => { state.records = state.records.filter(r => r.id !== del.dataset.delete); persist(); renderHistory(); showToast("図面を削除しました"); });
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
document.addEventListener("visibilitychange", updateWakeLock);
document.addEventListener("pointerdown", () => { if (state.settings.wakeLock && !state.wakeLock) updateWakeLock(); }, { passive: true });
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); state.deferredInstall = e; $("installButton").classList.remove("hidden"); });
$("installButton").addEventListener("click", async () => { if (!state.deferredInstall) return; state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall = null; $("installButton").classList.add("hidden"); });
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js"));
$("date").value = today();
applySettings(); setMeasureKeyboard(state.settings.measureKeyboard); setProjectCollapsed(state.settings.projectCollapsed); updateQuickHint(); refresh(); renderHistory(); updateWakeLock();
