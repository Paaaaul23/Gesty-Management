'use strict';
// Tablas con buscador de texto, filtros por cada dato y orden por cualquier columna.
//
// dataTable(el, {
//   id: 'docs',                       // conserva búsqueda, filtros y orden entre recargas
//   rows: [...],
//   columns: [{
//     key, label,
//     type: 'text' | 'number' | 'money' | 'date' | 'enum',
//     get: r => valor,                // para ordenar, filtrar y buscar (por defecto r[key])
//     html: r => '…',                 // celda (por defecto el valor formateado)
//     label_of: v => 'texto',         // enum: texto de cada valor
//     cls: 'num', hidden: true,       // hidden: no se muestra pero se puede filtrar, ordenar y buscar
//     filter: false, sort: false,
//   }],
//   onRow: r => "openDoc(1)",         // código del clic en la fila
//   empty: '<div class="empty">…</div>',
//   footer: rows => '<tr>…</tr>',     // totales de las filas visibles
//   sort: { key, dir: 'asc' | 'desc' },
//   limit: 8,                         // muestra solo las primeras N (con "ver todas")
// })

const DT_STATE = {};
const dtNorm = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Fechas: ISO (2026-03-01, 2026-03-01 10:00:00) o españolas (01/03/2026, 1-3-26)
function dtIso(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return '';
}
const dtNum = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function dtValue(col, r) { return col.get ? col.get(r) : r[col.key]; }
function dtText(col, r) {
  const v = dtValue(col, r);
  if (v === null || v === undefined || v === '') return '';
  if (col.type === 'enum') return col.label_of ? col.label_of(v) : String(v);
  if (col.type === 'money') return money(v) + ' ' + String(v).replace('.', ',');
  if (col.type === 'number') return String(v).replace('.', ',');
  if (col.type === 'date') { const iso = dtIso(v); return iso ? iso.split('-').reverse().join('/') + ' ' + v : String(v); }
  return String(v);
}
function dtCell(col, r) {
  if (col.html) return col.html(r);
  const v = dtValue(col, r);
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
  if (col.type === 'money') return money(v);
  if (col.type === 'date') { const iso = dtIso(v); return iso ? iso.split('-').reverse().join('/') : esc(v); }
  if (col.type === 'enum') return esc(col.label_of ? col.label_of(v) : v);
  return esc(v);
}
function dtCompare(col, a, b) {
  const x = dtValue(col, a), y = dtValue(col, b);
  const ex = x === null || x === undefined || x === '', ey = y === null || y === undefined || y === '';
  if (ex || ey) return ex && ey ? 0 : ex ? 1 : -1;            // vacíos siempre al final
  if (col.type === 'number' || col.type === 'money') return (dtNum(x) ?? 0) - (dtNum(y) ?? 0);
  if (col.type === 'date') return dtIso(x).localeCompare(dtIso(y)) || String(x).localeCompare(String(y));
  return dtText(col, a).localeCompare(dtText(col, b), 'es', { numeric: true, sensitivity: 'base' });
}
function dtActive(f) {
  if (f === undefined || f === null) return false;
  if (typeof f === 'string') return f !== '';
  return Object.values(f).some(v => v !== '' && v !== null && v !== undefined);
}
function dtMatches(cols, st, r) {
  for (const col of cols) {
    const f = st.f[col.key];
    if (!dtActive(f)) continue;
    const v = dtValue(col, r);
    if (col.type === 'enum') { if (String(v ?? '') !== f) return false; }
    else if (col.type === 'number' || col.type === 'money') {
      const n = dtNum(v), min = dtNum(String(f.min ?? '').replace(',', '.')), max = dtNum(String(f.max ?? '').replace(',', '.'));
      if (n === null || (min !== null && n < min) || (max !== null && n > max)) return false;
    } else if (col.type === 'date') {
      const d = dtIso(v);
      if (!d || (f.from && d < f.from) || (f.to && d > f.to)) return false;
    } else if (!dtNorm(dtText(col, r)).includes(dtNorm(f))) return false;
  }
  if (st.q) {
    const hay = dtNorm(cols.map(c => dtText(c, r)).join(' · '));
    if (!dtNorm(st.q).split(/\s+/).filter(Boolean).every(w => hay.includes(w))) return false;
  }
  return true;
}

function dataTable(el, opts) {
  if (typeof el === 'string') el = $(el);
  if (!el) return;
  const id = opts.id || el.id;
  const cols = opts.columns;
  const st = DT_STATE[id] ||= { q: '', f: {}, sort: opts.sort || null, open: false, all: false };
  const rows = opts.rows || [];
  if (!rows.length) { el.innerHTML = opts.empty || '<div class="empty">Sin datos</div>'; return; }

  const filterable = cols.filter(c => c.filter !== false);
  const sortable = cols.filter(c => c.sort !== false);
  const shown = cols.filter(c => !c.hidden);
  const enumOptions = col => {
    const vals = new Map();
    for (const r of rows) { const v = dtValue(col, r); if (v !== null && v !== undefined && v !== '') vals.set(String(v), col.label_of ? col.label_of(v) : String(v)); }
    return [...vals].sort((a, b) => a[1].localeCompare(b[1], 'es', { numeric: true }));
  };
  const filterField = col => {
    const f = st.f[col.key] || '';
    const name = esc(col.label);
    if (col.type === 'enum') return `<div class="field"><label>${name}</label><select data-f="${col.key}"><option value="">Todos</option>${enumOptions(col).map(([v, t]) => `<option value="${esc(v)}" ${v === f ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
    if (col.type === 'number' || col.type === 'money') return `<div class="field"><label>${name}</label><div class="dt-range"><input data-f="${col.key}" data-p="min" inputmode="decimal" placeholder="Desde" value="${esc(f.min ?? '')}"><input data-f="${col.key}" data-p="max" inputmode="decimal" placeholder="Hasta" value="${esc(f.max ?? '')}"></div></div>`;
    if (col.type === 'date') return `<div class="field"><label>${name}</label><div class="dt-range dates"><input type="date" data-f="${col.key}" data-p="from" title="Desde" value="${esc(f.from ?? '')}"><input type="date" data-f="${col.key}" data-p="to" title="Hasta" value="${esc(f.to ?? '')}"></div></div>`;
    return `<div class="field"><label>${name}</label><input data-f="${col.key}" placeholder="Contiene…" value="${esc(f)}"></div>`;
  };
  const sortIcon = col => st.sort?.key === col.key ? icon(st.sort.dir === 'asc' ? 'arrow-up' : 'arrow-down', 'dt-arrow on') : icon('arrow-up-down', 'dt-arrow');

  el.innerHTML = `<div class="dt">
    <div class="dt-bar">
      <label class="dt-search">${icon('search')}<input type="search" placeholder="Buscar en todos los datos…" value="${esc(st.q)}" aria-label="Buscar"></label>
      <button type="button" class="btn sm dt-ftoggle">${icon('list-filter')}Filtros<span class="dt-nf"></span></button>
      <div class="field dt-sortsel"><select aria-label="Ordenar por"><option value="">Ordenar por…</option>${sortable.map(c => `<option value="${c.key}|asc">${esc(c.label)} ↑</option><option value="${c.key}|desc">${esc(c.label)} ↓</option>`).join('')}</select></div>
      <button type="button" class="btn sm dt-clear hidden">${icon('x')}Quitar filtros</button>
      <span class="muted dt-count"></span>
    </div>
    <div class="dt-filters ${st.open ? '' : 'hidden'}">${filterable.map(filterField).join('')}</div>
    <div class="table-wrap"><table class="table"><thead><tr>${shown.map(c => `<th class="${c.cls || ''} ${c.sort === false ? '' : 'dt-sortable'}" data-k="${c.key}">${esc(c.label)}${c.sort === false ? '' : sortIcon(c)}</th>`).join('')}</tr></thead><tbody></tbody><tfoot></tfoot></table></div>
    <div class="dt-more"></div>
  </div>`;

  const paint = () => {
    let list = rows.filter(r => dtMatches(cols, st, r));
    if (st.sort) { const col = cols.find(c => c.key === st.sort.key); if (col) { const k = st.sort.dir === 'desc' ? -1 : 1; list = [...list].sort((a, b) => dtCompare(col, a, b) * k); } }
    const limited = opts.limit && !st.all && list.length > opts.limit ? list.slice(0, opts.limit) : list;
    $('tbody', el).innerHTML = limited.length ? limited.map(r => {
      const click = opts.onRow?.(r);
      return `<tr class="${click ? 'clickable' : ''} ${opts.rowClass?.(r) || ''}" ${click ? `onclick="${esc(click)}"` : ''}>${shown.map(c => `<td class="${c.cls || ''}">${dtCell(c, r)}</td>`).join('')}</tr>`;
    }).join('') : `<tr><td colspan="${shown.length}"><div class="empty" style="padding:20px">${icon('search-x')}<div>Ningún resultado con esta búsqueda o filtros.</div></div></td></tr>`;
    $('tfoot', el).innerHTML = opts.footer && list.length ? opts.footer(list) : '';
    $('.dt-more', el).innerHTML = limited.length < list.length ? `<button type="button" class="btn sm">${icon('chevrons-down')}Ver las ${list.length}</button>` : '';
    const btn = $('.dt-more button', el); if (btn) btn.onclick = () => { st.all = true; paint(); };
    const nf = filterable.filter(c => dtActive(st.f[c.key])).length;
    $('.dt-nf', el).textContent = nf ? ` (${nf})` : '';
    $('.dt-ftoggle', el).classList.toggle('soft', nf > 0);
    $('.dt-clear', el).classList.toggle('hidden', !nf && !st.q);
    $('.dt-count', el).textContent = list.length === rows.length ? `${rows.length} ${rows.length === 1 ? 'registro' : 'registros'}` : `${list.length} de ${rows.length}`;
    $$('th[data-k]', el).forEach(th => { const c = cols.find(x => x.key === th.dataset.k); if (c.sort !== false) th.querySelector('.dt-arrow').outerHTML = sortIcon(c); });
    $('.dt-sortsel select', el).value = st.sort ? `${st.sort.key}|${st.sort.dir}` : '';
  };

  $('.dt-search input', el).oninput = e => { st.q = e.target.value; paint(); };
  $('.dt-ftoggle', el).onclick = () => { st.open = !st.open; $('.dt-filters', el).classList.toggle('hidden', !st.open); };
  $('.dt-clear', el).onclick = () => { st.q = ''; st.f = {}; dataTable(el, opts); };
  $('.dt-sortsel select', el).onchange = e => { const [key, dir] = e.target.value.split('|'); st.sort = key ? { key, dir } : null; paint(); };
  $$('th.dt-sortable', el).forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    st.sort = st.sort?.key !== k ? { key: k, dir: 'asc' } : st.sort.dir === 'asc' ? { key: k, dir: 'desc' } : null;
    paint();
  });
  $$('.dt-filters [data-f]', el).forEach(inp => inp.oninput = inp.onchange = () => {
    const k = inp.dataset.f;
    if (inp.dataset.p) st.f[k] = { ...(typeof st.f[k] === 'object' ? st.f[k] : {}), [inp.dataset.p]: inp.value };
    else st.f[k] = inp.value;
    paint();
  });
  paint();
}
