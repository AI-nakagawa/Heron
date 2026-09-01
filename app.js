"use strict";

const STORAGE_KEY = "field-area-records-v1";
const $ = (id) => document.getElementById(id);
const state = { mode: "triangle", records: loadRecords(), selected: new Set(), deleteId: null, deferredInstall: null };
const dimensionIds = ["sideA", "sideB", "sideC", "topBase", "bottomBase", "height"];

function loadRecords() {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records)); }
function number(id) { return Number($(id).value); }
function validPositive(values) { return values.every((v) => Number.isFinite(v) && v > 0); }
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function formatArea(value) { return Number(value).toLocaleString("ja-JP", { minimumFractionDigits: 3, maximumFractionDigits: 3 }); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }

function calculate(showMessage = true) {
  let area = null, error = "";
  if (state.mode === "triangle") {
    const [a,b,c] = [number("sideA"),number("sideB"),number("sideC")];
    if (!validPositive([a,b,c])) error = "3辺すべてに0より大きい数値を入力してください。";
    else if (a + b <= c || a + c <= b || b + c <= a) error = "この3辺では三角形が成立しません。最長辺は、残り2辺の合計より短くしてください。";
    else { const s = (a+b+c)/2; area = Math.sqrt(s*(s-a)*(s-b)*(s-c)); }
  } else {
    const [top,bottom,h] = [number("topBase"),number("bottomBase"),number("height")];
    if (!validPositive([top,bottom,h])) error = "上底・下底・高さに0より大きい数値を入力してください。";
    else area = (top+bottom)*h/2;
  }
  $("areaResult").textContent = area === null ? "—" : formatArea(area);
  if (showMessage) $("message").textContent = error;
  drawPreview();
  return { area, error };
}

function drawPreview() {
  const svg = $("shapePreview");
  const line = "#174c3c", fill = "#dce879", text = "#425b52";
  if (state.mode === "triangle") {
    const [a,b,c] = [number("sideA"),number("sideB"),number("sideC")];
    let p1=[42,152],p2=[278,152],p3=[160,36];
    if (validPositive([a,b,c]) && a+b>c && a+c>b && b+c>a) {
      const base=c, x=(b*b+base*base-a*a)/(2*base), y=Math.sqrt(Math.max(0,b*b-x*x));
      const scale=Math.min(230/base,112/Math.max(y,.01)); p2=[42+base*scale,152]; p3=[42+x*scale,152-y*scale];
      const shift=(320-(p2[0]-p1[0]))/2-p1[0]; p1[0]+=shift;p2[0]+=shift;p3[0]+=shift;
    }
    svg.innerHTML=`<polygon points="${p1} ${p2} ${p3}" fill="${fill}" fill-opacity=".72" stroke="${line}" stroke-width="4" stroke-linejoin="round"/><text x="${(p2[0]+p3[0])/2+8}" y="${(p2[1]+p3[1])/2}" fill="${text}" font-size="14" font-weight="700">a</text><text x="${(p1[0]+p3[0])/2-18}" y="${(p1[1]+p3[1])/2}" fill="${text}" font-size="14" font-weight="700">b</text><text x="${(p1[0]+p2[0])/2}" y="174" text-anchor="middle" fill="${text}" font-size="14" font-weight="700">c</text>`;
  } else {
    const top=number("topBase"),bottom=number("bottomBase"),h=number("height"); let topW=125,bottomW=235;
    if(validPositive([top,bottom,h])){const max=Math.max(top,bottom);topW=220*top/max;bottomW=220*bottom/max;}
    const x1=(320-bottomW)/2,x2=(320+bottomW)/2,t1=(320-topW)/2,t2=(320+topW)/2;
    svg.innerHTML=`<polygon points="${x1},152 ${x2},152 ${t2},42 ${t1},42" fill="${fill}" fill-opacity=".72" stroke="${line}" stroke-width="4" stroke-linejoin="round"/><line x1="160" y1="42" x2="160" y2="152" stroke="${line}" stroke-width="2" stroke-dasharray="6 5"/><text x="160" y="30" text-anchor="middle" fill="${text}" font-size="14" font-weight="700">上底</text><text x="160" y="175" text-anchor="middle" fill="${text}" font-size="14" font-weight="700">下底</text><text x="170" y="102" fill="${text}" font-size="14" font-weight="700">高さ</text>`;
  }
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode").forEach((button) => { const active=button.dataset.mode===mode;button.classList.toggle("active",active);button.setAttribute("aria-checked",String(active)); });
  $("triangleFields").classList.toggle("hidden",mode!=="triangle"); $("trapezoidFields").classList.toggle("hidden",mode!=="trapezoid");
  $("message").textContent=""; calculate(false);
}
function dimensionsForMode() { return state.mode === "triangle" ? {a:number("sideA"),b:number("sideB"),c:number("sideC")} : {top:number("topBase"),bottom:number("bottomBase"),height:number("height")}; }
function resetForm() { $("areaForm").reset(); $("recordId").value=""; $("date").value=today(); setMode("triangle"); $("saveButton").textContent="計算して保存"; dimensionIds.forEach(id=>$(id).value=""); calculate(false); }
function showToast(text) { const el=$("toast");el.textContent=text;el.classList.add("show");clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>el.classList.remove("show"),2200); }
function switchView(view) { document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.view===view)); $("calculatorView").classList.toggle("active",view==="calculator"); $("historyView").classList.toggle("active",view==="history"); if(view==="history") renderHistory(); window.scrollTo({top:0,behavior:"smooth"}); }

function saveRecord(event) {
  event.preventDefault(); const name=$("name").value.trim(); if(!name){$("message").textContent="名称・測点名を入力してください。";$("name").focus();return;}
  const calc=calculate(); if(calc.error) return;
  const existingId=$("recordId").value; const now=new Date().toISOString();
  const record={id:existingId||crypto.randomUUID(),name,date:$("date").value||today(),memo:$("memo").value.trim(),mode:state.mode,dimensions:dimensionsForMode(),area:calc.area,updatedAt:now,createdAt:now};
  const index=state.records.findIndex(r=>r.id===existingId); if(index>=0){record.createdAt=state.records[index].createdAt;state.records[index]=record;}else state.records.unshift(record);
  persist(); renderHistory(); showToast(index>=0?"記録を更新しました":"計算結果を保存しました"); resetForm(); switchView("history");
}
function dimensionText(record) { const d=record.dimensions; return record.mode==="triangle"?`a ${d.a}m・b ${d.b}m・c ${d.c}m`:`上底 ${d.top}m・下底 ${d.bottom}m・高さ ${d.height}m`; }
function renderHistory() {
  $("historyCount").textContent=state.records.length; $("emptyState").classList.toggle("hidden",state.records.length>0); $("historyList").innerHTML=state.records.map(r=>`<article class="record"><input class="record-checkbox" type="checkbox" aria-label="${escapeHtml(r.name)}を合計に含める" data-select="${r.id}" ${state.selected.has(r.id)?"checked":""}><div class="record-main"><button type="button" data-edit="${r.id}"><div class="record-name">${escapeHtml(r.name)}</div><div class="record-meta">${r.date} ｜ ${r.mode==="triangle"?"三角形":"台形"}<br>${escapeHtml(dimensionText(r))}</div></button></div><div><div class="record-area">${formatArea(r.area)} <small>m²</small></div><div class="record-actions"><button type="button" data-edit="${r.id}">編集</button><button type="button" class="delete" data-delete="${r.id}">削除</button></div></div></article>`).join("");
  updateTotal();
}
function updateTotal(){const chosen=state.records.filter(r=>state.selected.has(r.id));$("selectedCount").textContent=chosen.length;$("selectedTotal").textContent=formatArea(chosen.reduce((sum,r)=>sum+Number(r.area),0));}
function editRecord(id){const r=state.records.find(v=>v.id===id);if(!r)return;resetForm();$("recordId").value=r.id;$("name").value=r.name;$("date").value=r.date;$("memo").value=r.memo||"";setMode(r.mode);if(r.mode==="triangle"){$("sideA").value=r.dimensions.a;$("sideB").value=r.dimensions.b;$("sideC").value=r.dimensions.c;}else{$("topBase").value=r.dimensions.top;$("bottomBase").value=r.dimensions.bottom;$("height").value=r.dimensions.height;}$("saveButton").textContent="変更を保存";calculate();switchView("calculator");}
function deleteRecord(id){state.deleteId=id;$("deleteDialog").showModal();}
function download(filename,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);}
function csvCell(value){return `"${String(value??"").replace(/"/g,'""')}"`;}
function exportCsv(){if(!state.records.length){showToast("出力する記録がありません");return;}const head=["名称・測点名","日付","図形","辺a(m)","辺b(m)","辺c(m)","上底(m)","下底(m)","高さ(m)","面積(m²)","メモ"];const rows=state.records.map(r=>[r.name,r.date,r.mode==="triangle"?"三角形":"台形",r.dimensions.a,r.dimensions.b,r.dimensions.c,r.dimensions.top,r.dimensions.bottom,r.dimensions.height,r.area,r.memo].map(csvCell).join(","));download(`現場面積_${today()}.csv`,"\uFEFF"+[head.map(csvCell).join(","),...rows].join("\r\n"),"text/csv;charset=utf-8");}
function exportJson(){download(`現場面積バックアップ_${today()}.json`,JSON.stringify({app:"現場面積ノート",version:1,exportedAt:new Date().toISOString(),records:state.records},null,2),"application/json");}
async function importJson(file){try{const data=JSON.parse(await file.text());if(!data||!Array.isArray(data.records))throw new Error();const valid=data.records.filter(r=>r&&typeof r.id==="string"&&typeof r.name==="string"&&Number.isFinite(Number(r.area))&&["triangle","trapezoid"].includes(r.mode));if(valid.length!==data.records.length)throw new Error();const map=new Map(state.records.map(r=>[r.id,r]));valid.forEach(r=>map.set(r.id,r));state.records=[...map.values()].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));persist();renderHistory();showToast(`${valid.length}件を復元しました`);}catch{showToast("このバックアップは読み込めません");}finally{$("importJsonInput").value="";}}

document.querySelectorAll(".mode").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.mode)));
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.view)));
dimensionIds.forEach(id=>$(id).addEventListener("input",()=>calculate(false)));
$("areaForm").addEventListener("submit",saveRecord);$("clearButton").addEventListener("click",resetForm);
$("historyList").addEventListener("click",e=>{const edit=e.target.closest("[data-edit]");const del=e.target.closest("[data-delete]");if(edit)editRecord(edit.dataset.edit);if(del)deleteRecord(del.dataset.delete);});
$("historyList").addEventListener("change",e=>{if(!e.target.matches("[data-select]"))return;e.target.checked?state.selected.add(e.target.dataset.select):state.selected.delete(e.target.dataset.select);updateTotal();});
$("selectAllButton").addEventListener("click",()=>{state.records.forEach(r=>state.selected.add(r.id));renderHistory();});$("clearSelectionButton").addEventListener("click",()=>{state.selected.clear();renderHistory();});
$("cancelDeleteButton").addEventListener("click",()=>$("deleteDialog").close());$("confirmDeleteButton").addEventListener("click",()=>{state.records=state.records.filter(r=>r.id!==state.deleteId);state.selected.delete(state.deleteId);persist();renderHistory();$("deleteDialog").close();showToast("記録を削除しました");});
$("exportCsvButton").addEventListener("click",exportCsv);$("exportJsonButton").addEventListener("click",exportJson);$("importJsonInput").addEventListener("change",e=>e.target.files[0]&&importJson(e.target.files[0]));
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();state.deferredInstall=e;$("installButton").classList.remove("hidden");});$("installButton").addEventListener("click",async()=>{if(!state.deferredInstall)return;state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;$("installButton").classList.add("hidden");});
if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js"));
$("date").value=today();drawPreview();renderHistory();
