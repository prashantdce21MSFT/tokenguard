import * as vscode from 'vscode';
import { RealUsage } from './realusage';
import { allPrices } from './pricing';
import { Calibration, calibratedReasoningMultiplier } from './history';
import { RoiResult } from './roi';

/**
 * Renders an AgentsView-style HTML dashboard in a webview: summary cards, a
 * stacked cost-over-time area chart, and per-model cost attribution. Charts are
 * inline SVG built from injected data — no external scripts, CSP-safe.
 */

const PALETTE = ['#e5484d', '#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6'];

function esc(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function fmtUsd(n: number): string {
    return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

function fmtTokens(n: number): string {
    if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
    if (n >= 1000) { return `${(n / 1000).toFixed(1)}k`; }
    return String(n);
}

function card(value: string, label: string, sub = ''): string {
    return `<div class="card"><div class="cv">${esc(value)}</div><div class="cl">${esc(label)}</div>${sub ? `<div class="cs">${esc(sub)}</div>` : ''}</div>`;
}

/** Stacked area chart (SVG) of daily cost by model. */
function areaChart(u: RealUsage, models: string[], colorOf: Map<string, string>): string {
    const W = 900, H = 260, padL = 48, padB = 28, padT = 12, padR = 12;
    const days = u.daily;
    if (days.length === 0) { return '<div class="empty">No dated turns to chart.</div>'; }
    const maxCost = Math.max(...days.map(d => d.costUsd), 0.0001);
    const n = days.length;
    const x = (i: number) => padL + (n === 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
    const y = (v: number) => padT + (1 - v / maxCost) * (H - padT - padB);

    // Stacked cumulative per day
    const layers: string[] = [];
    const cumulative = new Array(n).fill(0);
    for (const model of models) {
        const topPts: string[] = [];
        const botPts: string[] = [];
        for (let i = 0; i < n; i++) {
            const base = cumulative[i];
            const val = days[i].byModel[model] ?? 0;
            botPts.push(`${x(i).toFixed(1)},${y(base).toFixed(1)}`);
            topPts.push(`${x(i).toFixed(1)},${y(base + val).toFixed(1)}`);
            cumulative[i] = base + val;
        }
        const path = `${topPts.join(' ')} ${botPts.reverse().join(' ')}`;
        layers.push(`<polygon points="${path}" fill="${colorOf.get(model)}" fill-opacity="0.75" stroke="none"><title>${esc(model)}</title></polygon>`);
    }

    // Axis labels
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
        const val = maxCost * f;
        return `<text x="${padL - 6}" y="${(y(val) + 3).toFixed(1)}" class="tick" text-anchor="end">${fmtUsd(val)}</text>
                <line x1="${padL}" y1="${y(val).toFixed(1)}" x2="${W - padR}" y2="${y(val).toFixed(1)}" class="grid"/>`;
    }).join('');
    const step = Math.max(1, Math.floor(n / 8));
    const xTicks = days.map((d, i) => (i % step === 0 || i === n - 1)
        ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="tick" text-anchor="middle">${esc(d.date.slice(5))}</text>` : '').join('');

    return `<svg viewBox="0 0 ${W} ${H}" class="chart">${yTicks}${layers.join('')}${xTicks}</svg>`;
}

/** Horizontal cost-attribution bars per model. */
function attributionBars(u: RealUsage, colorOf: Map<string, string>): string {
    const total = u.totalCostUsd || 1;
    return u.perModel.map(m => {
        const pct = (m.costUsd / total) * 100;
        return `<div class="bar-row">
            <div class="bar-label"><span class="dot" style="background:${colorOf.get(m.model)}"></span>${esc(m.model)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${colorOf.get(m.model)}"></div></div>
            <div class="bar-val">${fmtUsd(m.costUsd)} · ${pct.toFixed(1)}%</div>
        </div>`;
    }).join('');
}

/** Horizontal cost-attribution bars per project. */
function projectBars(u: RealUsage): string {
    const total = u.totalCostUsd || 1;
    return u.perProject.map((p, i) => {
        const pct = (p.costUsd / total) * 100;
        const color = PALETTE[i % PALETTE.length];
        return `<div class="bar-row">
            <div class="bar-label"><span class="dot" style="background:${color}"></span>${esc(p.project)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
            <div class="bar-val">${fmtUsd(p.costUsd)} · ${pct.toFixed(1)}%</div>
        </div>`;
    }).join('');
}

/** Top sessions drill-down: workspace, session, tokens, and the peak turn. */
function sessionsPanel(u: RealUsage): string {
    if (u.sessions.length === 0) {
        return '';
    }
    const rows = u.sessions.slice(0, 40).map(s => {
        const peak = `${fmtTokens(s.peakInput)}${s.peakFile ? ' · ' + esc(s.peakFile) : ''}`;
        const snip = s.peakSnippet ? esc(s.peakSnippet) : '';
        return `<tr>
            <td>${esc(s.project)}</td>
            <td title="${esc(s.title)}">${esc(s.title.slice(0, 50))}</td>
            <td class="r">${s.turns}</td>
            <td class="r">${fmtTokens(s.inputTokens)}</td>
            <td class="r">${fmtTokens(s.outputTokens)}</td>
            <td class="r">${fmtUsd(s.costUsd)}</td>
            <td class="r">${peak}</td>
            <td title="${snip}">${snip.slice(0, 60)}</td></tr>`;
    }).join('');
    return `<div class="panel"><h2>Top Sessions by Input Tokens</h2>
<table><thead><tr><th>Workspace</th><th>Session</th><th class="r">Turns</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cost</th><th class="r">Peak turn</th><th>Peak prompt</th></tr></thead><tbody>${rows}</tbody></table>
<div class="note">"Peak turn" is the single most expensive turn in the session — its input tokens and the top attached file. Hover Session / Peak prompt for full text.</div>
</div>`;
}

export function renderDashboardHtml(u: RealUsage): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const data = JSON.stringify({
        cells: u.cells,
        sessions: u.sessions,
        scope: u.scope,
        sessionsScanned: u.sessionsScanned,
        palette: PALETTE,
        prices: u.prices,
        priceTable: allPrices()
    }).replace(/</g, '\\u003c');

    const body = `
<div class="filters">
  <label>From <input type="date" id="fFrom"></label>
  <label>To <input type="date" id="fTo"></label>
  <div class="multi"><button id="mModels" class="mbtn">Models ▾</button><div id="dModels" class="menu"></div></div>
  <div class="multi"><button id="mProjects" class="mbtn">Workspaces ▾</button><div id="dProjects" class="menu"></div></div>
  <label>Search <input type="search" id="fSearch" placeholder="prompt text…"></label>
  <button id="fReset" class="mbtn">Reset</button>
  <span class="spacer"></span>
  <button id="expCsv" class="mbtn ghost">⬇ CSV</button>
  <button id="expJson" class="mbtn ghost">⬇ JSON</button>
</div>
<div class="cards" id="cards"></div>
<div class="panel accent-amber" id="insightsPanel"><h2>💡 Savings &amp; Insights</h2><div id="insights"></div>
<div class="note">What-if figures re-price the <em>same</em> ground-truth tokens on a cheaper model — an upper-bound opportunity, not a promise. Quality trade-offs are yours to judge.</div></div>
<div class="panel"><h2>Cost Over Time <span class="h2sub">stacked by model · cumulative overlay</span></h2>
  <div class="chart-wrap"><div id="chart"></div><div id="chartTip" class="chart-tip"></div></div>
  <div class="chart-ctl"><label class="chk"><input type="checkbox" id="tglCum" checked> Cumulative line</label><label class="chk"><input type="checkbox" id="tglMa"> 7-day average</label></div>
  <div class="legend" id="legend"></div></div>
<div class="grid2">
  <div class="panel"><h2>Cost Attribution by Model</h2><div id="attrModel"></div></div>
  <div class="panel" id="attrProjWrap"><h2>Cost Attribution by Workspace</h2><div id="attrProj"></div></div>
</div>
<div class="panel"><h2>Model Efficiency <span class="h2sub">cost per unit &amp; input/output split</span></h2>
<table><thead><tr><th>Model</th><th class="r">$/turn</th><th class="r">$/1k in</th><th class="r">$/1k out</th><th class="r">Out/In</th><th>Cost split (in ▸ out)</th></tr></thead><tbody id="effRows"></tbody></table>
<div class="note">$/1k out is the sharpest lever — high-ratio, high-$/1k-out models are the ones to challenge on routine work. The split bar shows how much spend is prompt (input) vs generation (output).</div>
</div>
<div class="panel"><h2>Per-Model Detail</h2>
<table><thead><tr><th>Model</th><th class="r">Turns</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cost</th></tr></thead><tbody id="modelRows"></tbody></table>
<div class="note">Tokens are ground truth from Copilot. Cost is a list-price upper bound (no prompt-cache discount unless <code>tokenguard.assumedCacheReadFraction</code> is set).</div>
</div>
<div class="panel"><h2>Top Sessions by Input Tokens</h2>
<table><thead><tr><th>Workspace</th><th>Session</th><th class="r">Turns</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cost</th><th class="r">Peak turn</th><th>Peak prompt</th></tr></thead><tbody id="sessRows"></tbody></table>
<div class="note">Click a session row to expand its turn-by-turn history (prompt, model, tokens, cost, file). "Peak turn" is the single most expensive turn. Filtered by workspace + date above.</div>
</div>
<script nonce="${nonce}">
const DATA = ${data};
${CLIENT_SCRIPT}
</script>`;

    return pageShellScripted('TokenGuard — Usage Dashboard',
        `Real Copilot token counts · ${u.scope === 'all' ? 'all workspaces' : 'this workspace'} · ${u.sessionsScanned} sessions · ${u.activeDays} active days`,
        body, nonce);
}

const STYLE = `
:root{color-scheme:light dark}
body{font-family:var(--vscode-font-family),system-ui;margin:0;padding:20px;background:var(--vscode-editor-background);color:var(--vscode-foreground)}
h1{font-size:18px;margin:0 0 4px}.sub{opacity:.7;font-size:12px;margin-bottom:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:20px}
.card{border:1px solid var(--vscode-panel-border,#8884);border-radius:8px;padding:12px 14px}
.cv{font-size:22px;font-weight:700}.cl{font-size:11px;opacity:.7;margin-top:2px}.cs{font-size:10px;opacity:.5;margin-top:2px}
.panel{border:1px solid var(--vscode-panel-border,#8884);border-radius:8px;padding:16px;margin-bottom:18px}
.panel h2{font-size:13px;margin:0 0 12px;font-weight:600}
.chart{width:100%;height:auto}.tick{font-size:9px;fill:var(--vscode-foreground);opacity:.6}.grid{stroke:var(--vscode-panel-border,#8884);stroke-opacity:.3}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;font-size:11px}
.leg,.bar-label{display:flex;align-items:center;gap:6px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.bar-row{display:grid;grid-template-columns:200px 1fr 130px;align-items:center;gap:10px;margin:6px 0;font-size:12px}
.bar-track{background:var(--vscode-panel-border,#8884);border-radius:4px;height:14px;overflow:hidden}
.bar-fill{height:100%}.bar-val{text-align:right;opacity:.8;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,#8884)}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
.empty{opacity:.6;font-size:12px;padding:20px;text-align:center}
.note{font-size:11px;opacity:.6;margin-top:8px}
.badge{padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600}
.b-kept{background:#22c55e33;color:#22c55e}.b-rework{background:#f59e0b33;color:#f59e0b}
.b-discarded{background:#e5484d33;color:#e5484d}.b-pending{background:#8888;opacity:.8}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px}
.filters label{font-size:12px;opacity:.85}
.filters input[type=date]{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#8884);border-radius:4px;padding:3px 6px}
.filters input[type=search]{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#8884);border-radius:4px;padding:3px 8px;min-width:180px}
.multi{position:relative}
.mbtn{background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#fff);border:1px solid var(--vscode-panel-border,#8884);border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer}
.menu{display:none;position:absolute;z-index:10;top:100%;left:0;margin-top:4px;max-height:260px;overflow:auto;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-panel-border,#8884);border-radius:6px;padding:6px;min-width:200px}
.menu.open{display:block}
.menu label{display:flex;align-items:center;gap:6px;font-size:12px;padding:3px 4px;cursor:pointer}
.sess-row{cursor:pointer}.sess-row:hover{background:var(--vscode-list-hoverBackground,#8881)}
.detwrap{max-height:320px;overflow:auto;padding:6px 0}
table.det{width:100%;font-size:11px}table.det th,table.det td{padding:4px 6px;border-bottom:1px solid var(--vscode-panel-border,#8883)}
table.det td:last-child{opacity:.85}
.filters{position:sticky;top:0;z-index:20;background:var(--vscode-editor-background);padding:8px 0}
.spacer{flex:1}
.mbtn.ghost{background:transparent}
.card{position:relative;overflow:hidden}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--acc,transparent)}
.card.a-cost{--acc:#e5484d}.card.a-credit{--acc:#a855f7}.card.a-in{--acc:#3b82f6}.card.a-out{--acc:#22c55e}
.card.a-turn{--acc:#f59e0b}.card.a-eff{--acc:#06b6d4}.card.a-peak{--acc:#ec4899}.card.a-neutral{--acc:#8888}
.cv{font-size:22px;font-weight:700;display:flex;align-items:baseline;gap:6px}
.delta{font-size:11px;font-weight:600;padding:1px 6px;border-radius:10px}
.delta.up{background:#e5484d22;color:#e5484d}.delta.down{background:#22c55e22;color:#22c55e}.delta.flat{background:#8882;opacity:.7}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:760px){.grid2{grid-template-columns:1fr}}
.h2sub{font-weight:400;opacity:.55;font-size:11px;margin-left:6px}
.accent-amber{border-color:#f59e0b66;background:#f59e0b0d}
.insight{display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--vscode-panel-border,#8883);font-size:13px}
.insight:last-child{border-bottom:none}
.insight .ic{font-size:16px;line-height:1.2}
.insight .txt{flex:1}.insight .txt b{font-weight:600}
.insight .val{font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
.insight .val.save{color:#22c55e}.insight .val.warn{color:#f59e0b}
.chart-wrap{position:relative}
.chart-ctl{display:flex;gap:16px;margin-top:6px;font-size:11px;opacity:.8}
.chart-ctl .chk{display:flex;align-items:center;gap:5px;cursor:pointer}
.chart-tip{position:absolute;pointer-events:none;display:none;background:var(--vscode-editorWidget-background,#1e1e1e);border:1px solid var(--vscode-panel-border,#8884);border-radius:6px;padding:6px 9px;font-size:11px;box-shadow:0 4px 14px #0006;min-width:120px;z-index:5}
.chart-tip .tt-d{opacity:.7;margin-bottom:3px}
.chart-tip .tt-r{display:flex;justify-content:space-between;gap:12px}
.split{display:flex;height:12px;border-radius:3px;overflow:hidden;min-width:120px}
.split .si{background:#3b82f6}.split .so{background:#22c55e}
.crosshair{stroke:var(--vscode-foreground);stroke-opacity:.35;stroke-dasharray:3 3}
.cumline{fill:none;stroke:var(--vscode-foreground);stroke-opacity:.55;stroke-width:1.5}
.maline{fill:none;stroke:#f59e0b;stroke-opacity:.9;stroke-width:1.5;stroke-dasharray:4 3}
`;

function pageShell(title: string, subtitle: string, body: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>${STYLE}</style></head><body>
<h1>${esc(title)}</h1>
<div class="sub">${esc(subtitle)}</div>
${body}
</body></html>`;
}

function pageShellScripted(title: string, subtitle: string, body: string, nonce: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${STYLE}</style></head><body>
<h1>${esc(title)}</h1>
<div class="sub">${esc(subtitle)}</div>
${body}
</body></html>`;
}

// Client-side renderer (plain JS, no backticks/${} so it nests safely in a TS template).
const CLIENT_SCRIPT = `
(function(){
  var cells=DATA.cells, palette=DATA.palette, prices=DATA.prices||{}, priceTable=DATA.priceTable||{};
  var vscodeApi=null; try{ vscodeApi=acquireVsCodeApi(); }catch(e){}
  var CW=900,CH=260,padL=48,padB=28,padT=12,padR=12;
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c];});}
  function fmtUsd(n){return n>=1000?('$'+(n/1000).toFixed(1)+'k'):n>=1?('$'+n.toFixed(2)):n>=0.001?('$'+n.toFixed(3)):('$'+n.toFixed(4));}
  function fmtTok(n){return n>=1e6?((n/1e6).toFixed(1)+'M'):n>=1000?((n/1000).toFixed(1)+'k'):(''+n);}
  function blended(p){return (p.input+p.output)/2;}
  function cheapestFamily(){var best=null;Object.keys(priceTable).forEach(function(k){var p=priceTable[k];if(!best||blended(p)<blended(best.p))best={k:k,p:p};});return best;}
  var models=Array.from(new Set(cells.map(function(c){return c.model;}))).sort();
  var projects=Array.from(new Set(cells.map(function(c){return c.project;}))).sort();
  var dates=cells.map(function(c){return c.date;}).filter(function(d){return d!=='undated';}).sort();
  var minDate=dates[0]||'', maxDate=dates[dates.length-1]||'';
  var colorOf={}; models.forEach(function(m,i){colorOf[m]=palette[i%palette.length];});
  var selModels=new Set(models), selProjects=new Set(projects);
  var fFrom=document.getElementById('fFrom'), fTo=document.getElementById('fTo');
  fFrom.value=minDate; fTo.value=maxDate;
  var chartMeta=null;
  function daysBefore(dateStr,n){var d=new Date(dateStr+'T00:00:00');d.setDate(d.getDate()-n);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  function buildMenu(id,items,sel,color){
    var el=document.getElementById(id); el.innerHTML='';
    items.forEach(function(it){
      var lab=document.createElement('label');
      var cb=document.createElement('input'); cb.type='checkbox'; cb.checked=true; cb.value=it;
      cb.onchange=function(){ if(cb.checked)sel.add(it); else sel.delete(it); render(); };
      lab.appendChild(cb);
      if(color){var d=document.createElement('span');d.className='dot';d.style.background=colorOf[it];lab.appendChild(d);}
      lab.appendChild(document.createTextNode(' '+it));
      el.appendChild(lab);
    });
  }
  buildMenu('dModels',models,selModels,true);
  buildMenu('dProjects',projects,selProjects,false);
  document.getElementById('mModels').onclick=function(){document.getElementById('dModels').classList.toggle('open');};
  document.getElementById('mProjects').onclick=function(){document.getElementById('dProjects').classList.toggle('open');};
  fFrom.onchange=render; fTo.onchange=render;
  document.getElementById('fSearch').oninput=render;
  document.getElementById('tglCum').onchange=render; document.getElementById('tglMa').onchange=render;
  document.getElementById('fReset').onclick=function(){
    selModels=new Set(models); selProjects=new Set(projects); fFrom.value=minDate; fTo.value=maxDate;
    document.getElementById('fSearch').value='';
    buildMenu('dModels',models,selModels,true); buildMenu('dProjects',projects,selProjects,false); render();
  };
  function filtered(){
    var f=fFrom.value,t=fTo.value;
    return cells.filter(function(c){
      if(!selModels.has(c.model))return false;
      if(!selProjects.has(c.project))return false;
      if(c.date!=='undated'){ if(f&&c.date<f)return false; if(t&&c.date>t)return false; }
      return true;
    });
  }
  function filteredSessions(){
    var f=fFrom.value,t=fTo.value;
    var q=(document.getElementById('fSearch').value||'').toLowerCase().trim();
    return (DATA.sessions||[]).filter(function(s){
      if(!selProjects.has(s.project))return false;
      if(s.date){ if(f&&s.date<f)return false; if(t&&s.date>t)return false; }
      if(q){
        var inTitle=String(s.title||'').toLowerCase().indexOf(q)>=0;
        var inTurn=(s.detail||[]).some(function(tn){return String(tn.snippet||'').toLowerCase().indexOf(q)>=0||String(tn.file||'').toLowerCase().indexOf(q)>=0;});
        if(!inTitle&&!inTurn)return false;
      }
      return true;
    });
  }
  function card(v,l,s,cls,delta){
    var d=delta?('<span class="delta '+delta.cls+'">'+delta.txt+'</span>'):'';
    return '<div class="card '+(cls||'a-neutral')+'"><div class="cv">'+esc(v)+d+'</div><div class="cl">'+esc(l)+'</div>'+(s?'<div class="cs">'+esc(s)+'</div>':'')+'</div>';
  }
  function bars(items,total){ total=total||1;
    return items.map(function(it){var pct=it.cost/total*100;return '<div class="bar-row"><div class="bar-label"><span class="dot" style="background:'+it.color+'"></span>'+esc(it.label)+'</div><div class="bar-track"><div class="bar-fill" style="width:'+pct.toFixed(1)+'%;background:'+it.color+'"></div></div><div class="bar-val">'+fmtUsd(it.cost)+' · '+pct.toFixed(1)+'%</div></div>';}).join('');
  }
  function xAt(i,n){return padL+(n===1?(CW-padL-padR)/2:(i/(n-1))*(CW-padL-padR));}
  function areaSvg(days,byDay,mlist,total,opts){
    if(days.length===0){chartMeta=null;return '<div class="empty">No dated turns in range.</div>';}
    var maxCost=Math.max.apply(null,days.map(function(d){return byDay[d].cost;}).concat([0.0001]));
    var n=days.length;
    function y(v){return padT+(1-v/maxCost)*(CH-padT-padB);}
    var cum=new Array(n).fill(0),layers='';
    mlist.forEach(function(m){var top=[],bot=[];for(var i=0;i<n;i++){var base=cum[i];var val=byDay[days[i]].byModel[m]||0;bot.push(xAt(i,n).toFixed(1)+','+y(base).toFixed(1));top.push(xAt(i,n).toFixed(1)+','+y(base+val).toFixed(1));cum[i]=base+val;}layers+='<polygon points="'+top.join(' ')+' '+bot.reverse().join(' ')+'" fill="'+colorOf[m]+'" fill-opacity="0.72"><title>'+esc(m)+'</title></polygon>';});
    var grid='';[0,0.25,0.5,0.75,1].forEach(function(f){var v=maxCost*f;grid+='<text x="'+(padL-6)+'" y="'+(y(v)+3).toFixed(1)+'" class="tick" text-anchor="end">'+fmtUsd(v)+'</text><line x1="'+padL+'" y1="'+y(v).toFixed(1)+'" x2="'+(CW-padR)+'" y2="'+y(v).toFixed(1)+'" class="grid"/>';});
    var step=Math.max(1,Math.floor(n/8)),xt='';
    for(var i=0;i<n;i++){if(i%step===0||i===n-1)xt+='<text x="'+xAt(i,n).toFixed(1)+'" y="'+(CH-8)+'" class="tick" text-anchor="middle">'+esc(days[i].slice(5))+'</text>';}
    var lines='';
    if(opts.cum && total>0){var run=0,pts=[];for(var i=0;i<n;i++){run+=byDay[days[i]].cost;var yy=padT+(1-run/total)*(CH-padT-padB);pts.push(xAt(i,n).toFixed(1)+','+yy.toFixed(1));}lines+='<polyline class="cumline" points="'+pts.join(' ')+'"/>';lines+='<text x="'+(CW-padR)+'" y="'+(padT+8)+'" class="tick" text-anchor="end">Σ '+fmtUsd(total)+'</text>';}
    if(opts.ma){var pts2=[];for(var i=0;i<n;i++){var s=0,c=0;for(var j=Math.max(0,i-6);j<=i;j++){s+=byDay[days[j]].cost;c++;}var av=s/c;pts2.push(xAt(i,n).toFixed(1)+','+y(av).toFixed(1));}lines+='<polyline class="maline" points="'+pts2.join(' ')+'"/>';}
    chartMeta={days:days,byDay:byDay,mlist:mlist,n:n,maxCost:maxCost,total:total};
    return '<svg viewBox="0 0 '+CW+' '+CH+'" class="chart" id="csvg">'+grid+layers+lines+'<line id="cx" class="crosshair" x1="0" y1="'+padT+'" x2="0" y2="'+(CH-padB)+'" style="display:none"/>'+xt+'</svg>';
  }
  function bindHover(){
    var wrap=document.querySelector('.chart-wrap'); var svg=document.getElementById('csvg'); var tip=document.getElementById('chartTip'); var cx=document.getElementById('cx');
    if(!wrap||!svg||!chartMeta){return;}
    function move(e){
      var rect=svg.getBoundingClientRect(); var fx=(e.clientX-rect.left)/rect.width*CW;
      var n=chartMeta.n; var i=0,bestd=1e9;
      for(var k=0;k<n;k++){var d=Math.abs(xAt(k,n)-fx);if(d<bestd){bestd=d;i=k;}}
      var day=chartMeta.days[i]; var dd=chartMeta.byDay[day];
      cx.style.display='block'; cx.setAttribute('x1',xAt(i,n).toFixed(1)); cx.setAttribute('x2',xAt(i,n).toFixed(1));
      var rows=chartMeta.mlist.filter(function(m){return (dd.byModel[m]||0)>0;}).sort(function(a,b){return (dd.byModel[b]||0)-(dd.byModel[a]||0);}).slice(0,5).map(function(m){return '<div class="tt-r"><span><span class="dot" style="background:'+colorOf[m]+'"></span> '+esc(m)+'</span><b>'+fmtUsd(dd.byModel[m])+'</b></div>';}).join('');
      tip.innerHTML='<div class="tt-d">'+esc(day)+'</div>'+rows+'<div class="tt-r" style="margin-top:3px;border-top:1px solid #8883;padding-top:3px"><span>Day total</span><b>'+fmtUsd(dd.cost)+'</b></div>';
      tip.style.display='block';
      var px=(xAt(i,n)/CW)*rect.width; var left=px+14; if(left>rect.width-140)left=px-150;
      tip.style.left=Math.max(0,left)+'px'; tip.style.top='8px';
    }
    svg.onmousemove=move;
    svg.onmouseleave=function(){tip.style.display='none';cx.style.display='none';};
  }
  function buildInsights(agg,fsess){
    var out=[]; var total=agg.totCost;
    if(total<=0){return '<div class="empty">No spend in the current selection.</div>';}
    var mlist=agg.mlist;
    // 1 · biggest cost driver
    if(mlist.length){var top=mlist[0];var pct=agg.byModel[top].cost/total*100;out.push({ic:'📊',html:'<b>'+esc(top)+'</b> is your biggest cost driver — '+pct.toFixed(0)+'% of spend across '+agg.byModel[top].turns.toLocaleString()+' turns.',val:fmtUsd(agg.byModel[top].cost),cls:''});}
    // 2 · cheaper-model opportunity (re-price premium tokens on the cheapest family)
    var cf=cheapestFamily();
    if(cf){
      var save=0,names=[];
      mlist.forEach(function(m){
        var pr=prices[m]; if(!pr)return;
        if(blended(pr)>=blended(cf.p)*4){
          var alt=(agg.byModel[m].input/1e6)*cf.p.input+(agg.byModel[m].output/1e6)*cf.p.output;
          var s=agg.byModel[m].cost-alt; if(s>0){save+=s;if(names.indexOf(m)<0)names.push(m);}
        }
      });
      if(save>0.005 && save/total>=0.05){
        out.push({ic:'💸',html:'If routine work on <b>'+esc(names.join(', '))+'</b> moved to a <b>'+esc(cf.k)+'</b>-class model, the same tokens would cost far less.',val:'save '+fmtUsd(save),cls:'save'});
      }
    }
    // 3 · input vs output cost balance
    var inShare=agg.totInCost/total, outShare=agg.totOutCost/total;
    if(inShare>=0.65){out.push({ic:'❄️',html:'<b>'+(inShare*100).toFixed(0)+'% of spend is prompt (input)</b> — a context-snowball signature. Trim attachments, reuse context, and let compaction summarise old turns.',val:fmtUsd(agg.totInCost)+' in',cls:'warn'});}
    else if(outShare>=0.60){out.push({ic:'📏',html:'<b>'+(outShare*100).toFixed(0)+'% of spend is generation (output)</b> — add brevity/output caps to verbose asks to stop paying for unread tokens.',val:fmtUsd(agg.totOutCost)+' out',cls:'warn'});}
    // 4 · most expensive session
    if(fsess.length){var ms=fsess.slice().sort(function(a,b){return b.costUsd-a.costUsd;})[0];if(ms&&ms.costUsd>0){out.push({ic:'🧾',html:'Priciest session: <b>'+esc(String(ms.title).slice(0,54))+'</b> in '+esc(ms.project)+' ('+ms.turns+' turns).',val:fmtUsd(ms.costUsd),cls:''});}}
    // 5 · spend concentration on peak day
    if(agg.peakDay){var pp=agg.byDay[agg.peakDay].cost/total*100;if(pp>=40){out.push({ic:'📈',html:'Spend is bursty — <b>'+agg.peakDay+'</b> alone is '+pp.toFixed(0)+'% of the range.',val:fmtUsd(agg.byDay[agg.peakDay].cost),cls:''});}}
    return out.map(function(o){return '<div class="insight"><span class="ic">'+o.ic+'</span><span class="txt">'+o.html+'</span><span class="val '+o.cls+'">'+esc(o.val)+'</span></div>';}).join('');
  }
  function render(){
    var fc=filtered();
    var totIn=0,totOut=0,totCost=0,totInCost=0,totOutCost=0,totTurns=0,byModel={},byProj={},byDay={},sessDays={};
    var last7=0,prev7=0; var f7=maxDate?daysBefore(maxDate,6):'', f14=maxDate?daysBefore(maxDate,13):'';
    fc.forEach(function(c){
      totIn+=c.input;totOut+=c.output;totCost+=c.cost;totInCost+=(c.inputCost||0);totOutCost+=(c.outputCost||0);totTurns+=c.turns;
      var m=byModel[c.model]||(byModel[c.model]={turns:0,input:0,output:0,cost:0,inCost:0,outCost:0});m.turns+=c.turns;m.input+=c.input;m.output+=c.output;m.cost+=c.cost;m.inCost+=(c.inputCost||0);m.outCost+=(c.outputCost||0);
      var p=byProj[c.project]||(byProj[c.project]={cost:0});p.cost+=c.cost;
      if(c.date!=='undated'){var d=byDay[c.date]||(byDay[c.date]={cost:0,byModel:{}});d.cost+=c.cost;d.byModel[c.model]=(d.byModel[c.model]||0)+c.cost;sessDays[c.date]=1;
        if(f7&&c.date>=f7){last7+=c.cost;} else if(f14&&c.date>=f14&&c.date<f7){prev7+=c.cost;}}
    });
    var mlist=Object.keys(byModel).sort(function(a,b){return byModel[b].cost-byModel[a].cost;});
    var plist=Object.keys(byProj).sort(function(a,b){return byProj[b].cost-byProj[a].cost;});
    var days=Object.keys(byDay).sort();
    var credits=Math.round(totCost/0.01);
    var peak=days.reduce(function(best,d){return (!best||byDay[d].cost>byDay[best].cost)?d:best;},null);
    var perTurn=totTurns?totCost/totTurns:0;
    function delta(cur,prev){if(!prev){return null;}var ch=(cur-prev)/prev*100;var cls=ch>2?'up':(ch<-2?'down':'flat');var sign=ch>=0?'+':'';return {cls:cls,txt:sign+ch.toFixed(0)+'%'};}
    var d7=delta(last7,prev7);
    document.getElementById('cards').innerHTML=[
      card(fmtUsd(totCost),'Total Cost (upper bound)','7d '+fmtUsd(last7),'a-cost',d7),
      card(fmtUsd(totInCost)+' / '+fmtUsd(totOutCost),'Input / Output Cost',(totCost?Math.round(totInCost/totCost*100):0)+'% input','a-in'),
      card(fmtUsd(perTurn),'Cost / Turn','across '+totTurns.toLocaleString()+' turns','a-turn'),
      card(credits.toLocaleString(),'Copilot AI Credits','','a-credit'),
      card(fmtTok(totIn),'Input Tokens','','a-in'),
      card(fmtTok(totOut),'Output Tokens','','a-out'),
      card(''+mlist.length,'Models','','a-eff'),
      card(peak?fmtUsd(byDay[peak].cost):'-','Peak Day',peak||'','a-peak')
    ].join('');
    // insights
    document.getElementById('insights').innerHTML=buildInsights(
      {totCost:totCost,totInCost:totInCost,totOutCost:totOutCost,mlist:mlist,byModel:byModel,byDay:byDay,peakDay:peak},
      filteredSessions());
    // chart
    document.getElementById('chart').innerHTML=areaSvg(days,byDay,mlist,totCost,{cum:document.getElementById('tglCum').checked,ma:document.getElementById('tglMa').checked});
    bindHover();
    document.getElementById('legend').innerHTML=mlist.map(function(m){return '<span class="leg"><span class="dot" style="background:'+colorOf[m]+'"></span>'+esc(m)+'</span>';}).concat(
      document.getElementById('tglCum').checked?['<span class="leg"><span class="dot" style="background:var(--vscode-foreground);opacity:.5"></span>cumulative Σ</span>']:[]).join('');
    document.getElementById('attrModel').innerHTML=bars(mlist.map(function(m){return {label:m,cost:byModel[m].cost,color:colorOf[m]};}),totCost);
    document.getElementById('attrProjWrap').style.display=plist.length>1?'block':'none';
    document.getElementById('attrProj').innerHTML=bars(plist.map(function(p,i){return {label:p,cost:byProj[p].cost,color:palette[i%palette.length]};}),totCost);
    // efficiency
    document.getElementById('effRows').innerHTML=mlist.map(function(m){
      var x=byModel[m];var pt=x.turns?x.cost/x.turns:0;var k1in=x.input?x.inCost/x.input*1000:0;var k1out=x.output?x.outCost/x.output*1000:0;
      var ratio=x.input?x.output/x.input:0;var tc=x.cost||1;var ip=x.inCost/tc*100;var op=x.outCost/tc*100;
      var split='<div class="split" title="in '+fmtUsd(x.inCost)+' · out '+fmtUsd(x.outCost)+'"><div class="si" style="width:'+ip.toFixed(0)+'%"></div><div class="so" style="width:'+op.toFixed(0)+'%"></div></div>';
      return '<tr><td><span class="dot" style="background:'+colorOf[m]+'"></span>'+esc(m)+'</td><td class="r">'+fmtUsd(pt)+'</td><td class="r">'+fmtUsd(k1in)+'</td><td class="r">'+fmtUsd(k1out)+'</td><td class="r">'+ratio.toFixed(2)+'</td><td>'+split+'</td></tr>';
    }).join('');
    document.getElementById('modelRows').innerHTML=mlist.map(function(m){var x=byModel[m];return '<tr><td><span class="dot" style="background:'+colorOf[m]+'"></span>'+esc(m)+'</td><td class="r">'+x.turns.toLocaleString()+'</td><td class="r">'+fmtTok(x.input)+'</td><td class="r">'+fmtTok(x.output)+'</td><td class="r">'+fmtUsd(x.cost)+'</td></tr>';}).join('');
    // sessions filtered by workspace + date + search
    var q=(document.getElementById('fSearch').value||'').toLowerCase().trim();
    var sess=filteredSessions().slice(0,q?100:40);
    document.getElementById('sessRows').innerHTML=sess.map(function(s,i){
      var peakt=fmtTok(s.peakInput)+(s.peakFile?(' · '+esc(s.peakFile)):'');
      var snip=esc(s.peakSnippet||'');
      var dlist=(s.detail||[]);
      if(q){ dlist=dlist.filter(function(tn){return String(tn.snippet||'').toLowerCase().indexOf(q)>=0||String(tn.file||'').toLowerCase().indexOf(q)>=0;}); }
      var det=dlist.map(function(tn){
        return '<tr><td>'+esc(tn.date||'')+'</td><td>'+esc(tn.model)+'</td><td class="r">'+fmtTok(tn.input)+'</td><td class="r">'+fmtTok(tn.output)+'</td><td class="r">'+fmtUsd(tn.cost)+'</td><td>'+(tn.file?esc(tn.file):'')+'</td><td>'+esc(String(tn.snippet||'').slice(0,90))+'</td></tr>';
      }).join('');
      var openNow=q?true:false;
      var arrow=openNow?'▾ ':'▸ ';
      var main='<tr class="sess-row" data-i="'+i+'"><td>'+arrow+esc(s.project)+'</td><td title="'+esc(s.title)+'">'+esc(String(s.title).slice(0,50))+'</td><td class="r">'+s.turns+'</td><td class="r">'+fmtTok(s.inputTokens)+'</td><td class="r">'+fmtTok(s.outputTokens)+'</td><td class="r">'+fmtUsd(s.costUsd)+'</td><td class="r">'+peakt+'</td><td title="'+snip+'">'+snip.slice(0,50)+'</td></tr>';
      var detail='<tr class="sess-detail" id="sd-'+i+'" style="display:'+(openNow?'table-row':'none')+'"><td colspan="8"><div class="detwrap"><table class="det"><thead><tr><th>Date</th><th>Model</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cost</th><th>File</th><th>Prompt</th></tr></thead><tbody>'+det+'</tbody></table></div></td></tr>';
      return main+detail;
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.sess-row'),function(row){
      row.onclick=function(){
        var i=row.getAttribute('data-i');
        var dr=document.getElementById('sd-'+i);
        var open=dr.style.display!=='none';
        dr.style.display=open?'none':'table-row';
        row.firstChild.innerHTML=(open?'▸ ':'▾ ')+row.firstChild.innerHTML.replace(/^[▸▾]\\s*/,'');
      };
    });
  }
  function exportData(fmt){
    var fc=filtered(); var content,fn;
    if(fmt==='json'){content=JSON.stringify(fc,null,2);fn='tokenguard-usage.json';}
    else{
      var head=['date','model','project','input','output','inputCost','outputCost','cost','turns'];
      var lines=[head.join(',')];
      fc.forEach(function(c){lines.push([c.date,'"'+String(c.model).replace(/"/g,'""')+'"','"'+String(c.project).replace(/"/g,'""')+'"',c.input,c.output,(c.inputCost||0).toFixed(6),(c.outputCost||0).toFixed(6),c.cost.toFixed(6),c.turns].join(','));});
      content=lines.join('\\n');fn='tokenguard-usage.csv';
    }
    if(vscodeApi){vscodeApi.postMessage({type:'export',format:fmt,content:content,filename:fn});}
  }
  document.getElementById('expCsv').onclick=function(){exportData('csv');};
  document.getElementById('expJson').onclick=function(){exportData('json');};
  render();
})();
`;

export function showDashboardPanel(u: RealUsage): void {
    const panel = vscode.window.createWebviewPanel(
        'tokenguard.dashboard',
        'TokenGuard Dashboard',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = renderDashboardHtml(u);
    panel.webview.onDidReceiveMessage(async (msg: { type?: string; format?: string; content?: string; filename?: string }) => {
        if (msg?.type !== 'export' || typeof msg.content !== 'string') {
            return;
        }
        const isJson = msg.format === 'json';
        const target = await vscode.window.showSaveDialog({
            saveLabel: 'Export usage',
            defaultUri: vscode.Uri.file(msg.filename || (isJson ? 'tokenguard-usage.json' : 'tokenguard-usage.csv')),
            filters: isJson ? { JSON: ['json'] } : { CSV: ['csv'] }
        });
        if (!target) {
            return;
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(msg.content, 'utf8'));
        vscode.window.showInformationMessage(`TokenGuard: exported ${isJson ? 'JSON' : 'CSV'} to ${target.fsPath}`);
    });
}

// ---- Calibration dashboard ----

export function renderCalibrationHtml(cal: Calibration): string {
    if (cal.totalTurns === 0) {
        return pageShell('TokenGuard — Personal Calibration', 'No usage history yet',
            '<div class="empty">Chat with Copilot a few times, then reopen this dashboard.</div>');
    }
    const cards = [
        card(cal.totalTurns.toLocaleString(), 'Turns learned from'),
        card(cal.baselineRatio !== undefined ? cal.baselineRatio.toFixed(3) : '—', 'Baseline out/in ratio'),
        card(cal.snowballP90 !== undefined ? fmtTokens(cal.snowballP90) : '—', 'Snowball p90 / turn'),
        card(`${Math.round(cal.duplicateRate * 100)}%`, 'Duplicate rate')
    ].join('');

    const stats = Object.values(cal.perModel).sort((a, b) => b.turns - a.turns);
    const rows = stats.map(s => {
        const mult = calibratedReasoningMultiplier(s.model);
        return `<tr>
            <td>${esc(s.model)}${s.reasoning ? ' <span class="badge b-rework">🧠</span>' : ''}</td>
            <td class="r">${s.turns.toLocaleString()}</td>
            <td class="r">${fmtTokens(Math.round(s.avgInput))}</td>
            <td class="r">${fmtTokens(Math.round(s.avgOutput))}</td>
            <td class="r">${s.outputInputRatio.toFixed(3)}</td>
            <td class="r">${fmtUsd(s.avgCostUsd)}</td>
            <td class="r">${mult !== undefined ? mult.toFixed(2) + '×' : '—'}</td></tr>`;
    }).join('');

    return pageShell('TokenGuard — Personal Calibration',
        `Learned from ${cal.totalTurns.toLocaleString()} turns${cal.realBacked ? ' · real Copilot token counts (ground truth)' : ''}`,
        `<div class="cards">${cards}</div>
<div class="panel"><h2>Per-Model Baselines</h2>
<table><thead><tr><th>Model</th><th class="r">Turns</th><th class="r">Avg in</th><th class="r">Avg out</th><th class="r">Out/In</th><th class="r">Avg cost</th><th class="r">Calib ×out</th></tr></thead><tbody>${rows}</tbody></table>
<div class="note">Calibrated multipliers and the snowball threshold feed the live rules automatically once a model has ≥ 8 turns of history.</div>
</div>`);
}

export function showCalibrationPanel(cal: Calibration): void {
    const panel = vscode.window.createWebviewPanel(
        'tokenguard.calibration', 'TokenGuard Calibration',
        vscode.ViewColumn.Active, { enableScripts: false, retainContextWhenHidden: true }
    );
    panel.webview.html = renderCalibrationHtml(cal);
}

// ---- Edit ROI dashboard ----

const VERDICT_BADGE: Record<string, string> = {
    kept: '<span class="badge b-kept">✅ kept</span>',
    rework: '<span class="badge b-rework">🔁 rework</span>',
    discarded: '<span class="badge b-discarded">🗑️ discarded</span>',
    pending: '<span class="badge b-pending">🕗 pending</span>'
};

export function renderRoiHtml(r: RoiResult): string {
    if (!r.workspaceRoot) {
        return pageShell('TokenGuard — Edit ROI', 'No workspace open',
            '<div class="empty">Open a folder to analyse edit ROI.</div>');
    }
    const cards = [
        card(String(r.kept), 'Kept ✅'),
        card(String(r.rework), 'Rework 🔁'),
        card(String(r.discarded), 'Discarded 🗑️'),
        card(String(r.pending), 'Pending 🕗')
    ].join('');

    const modelRows = r.perModel.map(m => `<tr>
        <td>${esc(m.model)}</td>
        <td class="r">${m.filesTouched}</td>
        <td class="r">${m.iterations}</td>
        <td class="r">${m.kept}</td>
        <td class="r">${m.rework}</td>
        <td class="r">${m.discarded}</td>
        <td class="r">${m.estCostUsd !== undefined ? fmtUsd(m.estCostUsd) : '—'}</td></tr>`).join('');

    const fileRows = r.files.slice(0, 60).map(f => `<tr>
        <td>${esc(f.relPath)}</td>
        <td>${f.models.length ? esc(f.models.join(', ')) : '—'}</td>
        <td class="r">${f.iterations}</td>
        <td class="r">${f.editOps}</td>
        <td>${VERDICT_BADGE[f.verdict]}</td></tr>`).join('');

    const modelPanel = r.perModel.length > 0
        ? `<div class="panel"><h2>Model ROI</h2>
<table><thead><tr><th>Model</th><th class="r">Files</th><th class="r">Iter</th><th class="r">✅</th><th class="r">🔁</th><th class="r">🗑️</th><th class="r">Est. spend</th></tr></thead><tbody>${modelRows}</tbody></table></div>`
        : `<div class="panel note">No model attribution (older transcripts). Iteration/verdict counts are still exact.</div>`;

    return pageShell('TokenGuard — Edit ROI (did the edits stick?)',
        `Scanned ${r.sessionsScanned} editing session(s) · ${r.files.length} files`,
        `<div class="cards">${cards}</div>
${modelPanel}
<div class="panel"><h2>Files by Iterations</h2>
<table><thead><tr><th>File</th><th>Model(s)</th><th class="r">Iter</th><th class="r">Edits</th><th>Verdict</th></tr></thead><tbody>${fileRows}</tbody></table>
<div class="note">🔁 rework = 3+ AI passes on one file (lowest ROI). 🗑️ discarded = AI-created files now gone. If a premium model dominates 🔁/🗑️, that's evidence it isn't paying off.</div>
</div>`);
}

export function showRoiPanel(r: RoiResult): void {
    const panel = vscode.window.createWebviewPanel(
        'tokenguard.roi', 'TokenGuard Edit ROI',
        vscode.ViewColumn.Active, { enableScripts: false, retainContextWhenHidden: true }
    );
    panel.webview.html = renderRoiHtml(r);
}
