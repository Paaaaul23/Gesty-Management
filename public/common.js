'use strict';
// Utilidades compartidas por login, panel de administrador y panel de cliente.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const res = await fetch(path, init);
  if (res.status === 401 && !path.startsWith('/api/login')) { location.href = '/login'; throw new Error('Sesión caducada'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2800);
}

const money = n => (n === null || n === undefined || n === '') ? '—' : Number(n).toLocaleString('es-ES', { style: 'currency', currency: 'EUR', useGrouping: 'always' });
const fmtDate = s => s ? new Date(s.replace(' ', 'T') + (s.length <= 19 ? 'Z' : '')).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const initials = s => String(s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');

const DOC_TYPES = { factura: 'Factura', rectificativa: 'Factura rectificativa', albaran: 'Albarán', pedido: 'Pedido', presupuesto: 'Presupuesto / oferta' };
const DIRECTIONS = { recibido: 'Recibido', emitido: 'Emitido' };
const shortMoney = n => { const a = Math.abs(n); return (n < 0 ? '−' : '') + (a >= 1000 ? (a / 1000).toLocaleString('es-ES', { maximumFractionDigits: a >= 10000 ? 0 : 1 }) + ' k€' : Math.round(a).toLocaleString('es-ES') + ' €'); };

// Tema claro/oscuro (respeta la preferencia del sistema si no se ha elegido)
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('gesty-theme'); } catch {}
  if (saved) document.documentElement.dataset.theme = saved;
  const btn = $('#themeBtn');
  if (!btn) return;
  const isDark = () => document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const paint = () => { btn.innerHTML = icon(isDark() ? 'sun' : 'moon'); };
  paint();
  btn.onclick = () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('gesty-theme', next); } catch {}
    paint();
  };
}

// Modal genérico con formulario
function openModal(title, bodyHtml, onSubmit, submitLabel = 'Guardar') {
  const m = $('#modal');
  m.innerHTML = `<form class="modal-box" novalidate>
    <div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-close title="Cerrar">${icon('x')}</button></div>
    <div class="form-grid">${bodyHtml}</div>
    <div class="actions" style="margin-top:18px"><button class="btn primary" type="submit">${icon('check')}${esc(submitLabel)}</button><button type="button" class="btn" data-close>Cancelar</button></div>
  </form>`;
  m.classList.add('show');
  const form = $('form', m);
  $$('[data-close]', m).forEach(b => b.onclick = closeModal);
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      await onSubmit(data);
      closeModal();
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  };
  setTimeout(() => $('input,select', form)?.focus(), 30);
}
function closeModal() { $('#modal').classList.remove('show'); $('#modal').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal')?.classList.contains('show')) closeModal(); });
document.addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });

function field(name, label, { value = '', type = 'text', full = false, required = false, options = null, placeholder = '' } = {}) {
  const input = options
    ? `<select name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`
    : `<input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''}>`;
  return `<div class="field ${full ? 'full' : ''}"><label>${esc(label)}${required ? ' *' : ''}</label>${input}</div>`;
}

function setupSidebar() {
  $('#collapseBtn').onclick = () => {
    const s = $('#sidebar');
    if (innerWidth < 720) s.classList.toggle('open'); else s.classList.toggle('collapsed');
  };
}

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
}
