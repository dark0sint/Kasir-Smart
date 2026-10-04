'use strict';
/* ===================== Kasir Smart - frontend ===================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rp = n => 'Rp\u00a0' + Math.round(+n || 0).toLocaleString('id-ID');
const num = n => (+n || 0).toLocaleString('id-ID', { maximumFractionDigits: 3 });
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowStr = () => { const d = new Date(); return ymd(d) + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const fmtDT = s => { if (!s) return ''; const [d, t] = s.split(' '); const [y, m, dd] = d.split('-'); return `${dd} ${MONTHS[+m - 1]} ${y}` + (t ? ` ${t.slice(0, 5)}` : ''); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const METHOD = { tunai: 'Tunai', qris: 'QRIS', debit: 'Debit', kredit: 'Kredit', ewallet: 'E-Wallet' };
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('Penyimpanan penuh', e); } },
  del(k) { try { localStorage.removeItem(k); } catch { } },
};

const S = {
  token: LS.get('ks_token', null), user: LS.get('ks_user', null),
  products: LS.get('ks_products', []), settings: LS.get('ks_settings', {}),
  cart: LS.get('ks_cart', []), queue: LS.get('ks_queue', []), failed: LS.get('ks_failed', []),
  view: 'pos', q: '', cat: 'Semua', online: navigator.onLine, sale: null, co: null,
};
const saveProducts = () => LS.set('ks_products', S.products);
const saveCart = () => LS.set('ks_cart', S.cart);
const saveQueue = () => { LS.set('ks_queue', S.queue); LS.set('ks_failed', S.failed); updateNet(); };
const isOwner = () => S.user && S.user.role === 'owner';

/* ---------- UI helper ---------- */
function toast(msg, type = '') {
  const d = document.createElement('div'); d.className = 't ' + type; d.textContent = msg;
  $('#toast').appendChild(d); setTimeout(() => d.remove(), type === 'err' ? 4500 : 2600);
}
let audioCtx;
function beep(ok = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = ok ? 1000 : 220; g.gain.value = .06; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + (ok ? .07 : .25));
  } catch { }
}
function modal(html, cls = '') {
  const root = $('#modal'); root.innerHTML = `<div class="sheet ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  root.hidden = false; document.body.classList.add('noscroll'); return root.firstElementChild;
}
function closeModal() { const r = $('#modal'); r.hidden = true; r.innerHTML = ''; document.body.classList.remove('noscroll'); stopScan(); }
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
const mhead = t => `<div class="mh"><h2>${t}</h2><button class="x" data-act="modal-close" aria-label="Tutup">×</button></div>`;

/* ---------- API ---------- */
async function api(path, o = {}) {
  const opt = { method: o.method || 'GET', headers: {} };
  if (S.token) opt.headers.Authorization = 'Bearer ' + S.token;
  if (o.body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(o.body); }
  let r;
  try { r = await fetch('/api' + path, opt); }
  catch { setOnline(false); const e = new Error('Tidak ada koneksi ke server'); e.network = true; throw e; }
  if ([502, 503, 504].includes(r.status)) { setOnline(false); const e = new Error('Server tidak dapat dihubungi'); e.network = true; throw e; }
  setOnline(true);
  if (o.raw) { if (!r.ok) throw new Error('Gagal mengunduh'); return r; }
  let j = {}; try { j = await r.json(); } catch { }
  if (r.status === 401 && path !== '/login') { doLogout(false); const e = new Error(j.error || 'Sesi berakhir'); e.status = 401; throw e; }
  if (!r.ok) { const e = new Error(j.error || 'Error ' + r.status); e.status = r.status; throw e; }
  return j;
}
function setOnline(v) { if (S.online !== v) { S.online = v; updateNet(); if (v) syncQueue(); } }
function updateNet() {
  const p = $('#netpill'); if (!p) return;
  p.classList.toggle('off', !S.online); p.lastElementChild.textContent = S.online ? 'Online' : 'Offline';
  const q = $('#qbadge'), n = S.queue.length + S.failed.length;
  q.hidden = !n; q.textContent = (S.failed.length ? '⚠ ' : '↻ ') + n + ' belum sinkron';
}
window.addEventListener('online', () => { setOnline(true); });
window.addEventListener('offline', () => setOnline(false));

/* ---------- Login / boot ---------- */
function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false; closeModal();
  $('#lerr').textContent = ''; setTimeout(() => $('#lu').focus(), 50);
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#lerr').textContent = '';
  try {
    const r = await api('/login', { method: 'POST', body: { username: $('#lu').value, password: $('#lp').value } });
    S.token = r.token; S.user = r.user; LS.set('ks_token', r.token); LS.set('ks_user', r.user);
    $('#lp').value = ''; await boot();
  } catch (err) { $('#lerr').textContent = err.message; }
});
async function doLogout(call = true) {
  if (call && S.queue.length && !confirm('Ada transaksi offline yang belum terkirim. Keluar tetap akan menyimpannya di perangkat ini. Lanjut keluar?')) return;
  if (call && S.token && S.online) { try { await api('/logout', { method: 'POST' }); } catch { } }
  S.token = null; S.user = null; LS.del('ks_token'); LS.del('ks_user'); showLogin();
}
async function loadBootstrap() {
  const b = await api('/bootstrap');
  S.user = b.user; S.settings = b.settings; S.products = b.products;
  LS.set('ks_user', b.user); LS.set('ks_settings', b.settings); saveProducts();
}
async function boot() {
  if (!S.token) return showLogin();
  try { await loadBootstrap(); }
  catch (e) { if (e.status === 401 || !S.user) return showLogin(); toast('Mode offline: memakai data tersimpan', ''); }
  $('#login').hidden = true; $('#app').hidden = false;
  buildShell(); route(); updateNet(); syncQueue();
}
async function refreshProducts() {
  if (!S.token || !S.online || document.hidden) return;
  try {
    const b = await api('/bootstrap'); S.products = b.products; S.settings = b.settings; saveProducts(); LS.set('ks_settings', b.settings);
    if (S.view === 'pos' && $('#grid')) { renderCats(); renderGrid(); }
    updateNavBadge();
  } catch { }
}

/* ---------- Shell & routing ---------- */
const ICON = {
  pos: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  hist: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  prod: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  rep: '<path d="M5 20V11M11 20V4M17 20v-6M3 20h18"/>',
  exp: '<path d="M3 7h16a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M3 7l12-4v4M17 14h2"/>',
  set: '<path d="M4 6h8M18 6h2M4 12h2M12 12h8M4 18h10M20 18h0"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
};
const NAV = [['pos', 'Kasir', 0], ['hist', 'Riwayat', 0], ['prod', 'Produk', 1], ['rep', 'Laporan', 1], ['exp', 'Biaya', 1], ['set', 'Setelan', 0]];
function buildShell() {
  $('#brand').textContent = S.settings.store_name || 'Kasir Smart';
  $('#nav').innerHTML = NAV.filter(n => !n[2] || isOwner()).map(n =>
    `<a href="#/${n[0]}" data-v="${n[0]}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[n[0]]}</svg>${n[1]}</a>`).join('');
  updateNavBadge();
}
const lowList = () => S.products.filter(p => p.min_stock > 0 && p.stock <= p.min_stock);
function updateNavBadge() {
  const a = $('#nav a[data-v=prod]'); if (!a) return;
  $('.dot', a)?.remove(); const n = lowList().length;
  if (n) a.insertAdjacentHTML('beforeend', `<span class="dot">${n}</span>`);
}
const VIEWS = { pos: viewPOS, hist: viewHist, prod: viewProd, rep: viewReport, exp: viewExp, set: viewSet };
function route() {
  if (!S.user) return;
  let v = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'pos';
  if (!VIEWS[v] || (['prod', 'rep', 'exp'].includes(v) && !isOwner())) v = 'pos';
  S.view = v; closeModal();
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === v));
  $('#view').scrollTop = 0; window.scrollTo(0, 0);
  VIEWS[v]();
}
window.addEventListener('hashchange', route);

/* ---------- Event delegation ---------- */
const ACT = {};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const f = ACT[el.dataset.act]; if (f) f(el, e);
});
ACT['modal-close'] = closeModal;

/* =============================== KASIR (POS) =============================== */
const cartSub = () => S.cart.reduce((a, i) => a + Math.round(i.price * i.qty), 0);
const cartCount = () => S.cart.reduce((a, i) => a + i.qty, 0);
const taxPct = () => +S.settings.tax_percent || 0;

function viewPOS() {
  $('#view').innerHTML = `<div class="pos">
    <section>
      <div class="searchbar">
        <input id="q" type="search" placeholder="Cari nama atau scan barcode…" autocomplete="off" value="${esc(S.q)}" aria-label="Cari produk">
        <button class="btn pri" data-act="scan" aria-label="Scan dengan kamera">Scan</button>
      </div>
      <div id="cats" class="chips"></div>
      <div id="grid" class="grid"></div>
    </section>
    <aside id="cart" class="cart" aria-label="Keranjang"></aside>
  </div>
  <button class="fab" id="fab" data-act="cart-open"></button>`;
  renderCats(); renderGrid(); renderCart();
  const q = $('#q');
  q.addEventListener('input', () => { S.q = q.value; renderGrid(); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchEnter(); } });
}
function renderCats() {
  const el = $('#cats'); if (!el) return;
  const cats = ['Semua', ...new Set(S.products.map(p => p.category).filter(Boolean))];
  if (!cats.includes(S.cat)) S.cat = 'Semua';
  el.innerHTML = cats.map(c => `<button class="chip ${c === S.cat ? 'on' : ''}" data-act="cat" data-c="${esc(c)}">${esc(c)}</button>`).join('');
}
ACT.cat = el => { S.cat = el.dataset.c; renderCats(); renderGrid(); };
function filtered() {
  const q = S.q.trim().toLowerCase();
  return S.products.filter(p => (S.cat === 'Semua' || p.category === S.cat) && (!q ||
    p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q) || (p.category || '').toLowerCase().includes(q) ||
    p.variants.some(v => v.name.toLowerCase().includes(q) || (v.barcode || '').includes(q))));
}
function renderGrid() {
  const el = $('#grid'); if (!el) return;
  const list = filtered();
  if (!list.length) { el.innerHTML = `<div class="empty" style="grid-column:1/-1">${S.products.length ? 'Produk tidak ditemukan.' : 'Belum ada produk. ' + (isOwner() ? 'Tambahkan di menu Produk.' : 'Minta pemilik menambahkan produk.')}</div>`; return; }
  el.innerHTML = list.map(p => {
    const low = p.min_stock > 0 && p.stock <= p.min_stock, out = p.stock <= 0;
    const price = p.variants.length ? 'mulai ' + rp(Math.min(...p.variants.map(v => v.price))) : rp(p.price);
    return `<button class="tile ${out ? 'out' : low ? 'low' : ''}" data-act="pick" data-id="${p.id}">
      ${p.variants.length ? `<span class="vtag">${p.variants.length} varian</span>` : ''}
      <b>${esc(p.name)}</b><div><div class="pr">${price}</div>
      <div class="st">${out ? 'Habis' : (low ? 'Menipis: ' : 'Stok ') + num(p.stock) + ' ' + esc(p.unit)}</div></div></button>`;
  }).join('');
}
ACT.pick = el => pickProduct(S.products.find(p => p.id == el.dataset.id));
function pickProduct(p) { if (!p) return; if (p.variants.length) variantModal(p); else addItem(p, null); }
function variantModal(p) {
  modal(mhead(esc(p.name)) + `<div class="list">${p.variants.map(v => `
    <button class="item" data-act="pickv" data-p="${p.id}" data-v="${v.id}">
      <span class="t">${esc(v.name)}</span><span class="a">${rp(v.price)}</span>
      <small>${v.stock <= 0 ? 'Habis' : 'Stok ' + num(v.stock)}</small></button>`).join('')}</div>`);
}
ACT.pickv = el => {
  const p = S.products.find(x => x.id == el.dataset.p), v = p.variants.find(x => x.id == el.dataset.v);
  if (addItem(p, v)) closeModal();
};
function findBarcode(code) {
  for (const p of S.products) {
    if (p.barcode === code) return [p, null];
    for (const v of p.variants) if (v.barcode === code) return [p, v];
  }
  return null;
}
function searchEnter() {
  const code = $('#q').value.trim(); if (!code) return;
  const hit = findBarcode(code);
  if (hit) { addItem(hit[0], hit[1]); }
  else { const l = filtered(); if (l.length === 1) pickProduct(l[0]); else if (/^\d{6,}$/.test(code)) { beep(false); toast('Barcode ' + code + ' tidak terdaftar', 'err'); } else return; }
  $('#q').value = ''; S.q = ''; renderGrid();
}
function addItem(p, v, qty = 1) {
  const src = v || p, key = p.id + ':' + (v ? v.id : 0);
  const it = S.cart.find(i => i.key === key), want = (it ? it.qty : 0) + qty;
  if (S.settings.allow_negative !== '1' && want > src.stock) { beep(false); toast(`Stok ${p.name} tidak cukup (sisa ${num(src.stock)})`, 'err'); return false; }
  if (it) it.qty = want;
  else S.cart.push({ key, product_id: p.id, variant_id: v ? v.id : null, name: p.name + (v ? ' - ' + v.name : ''), price: src.price, qty, unit: p.unit });
  saveCart(); renderCart(); beep(true); return true;
}
function renderCart() {
  const el = $('#cart'); if (!el) return;
  const sub = cartSub(), tp = taxPct(), tax = Math.round(sub * tp / 100);
  el.innerHTML = `<div class="cart-head"><b>Pesanan</b><span>${num(cartCount())} item</span><button class="x" data-act="cart-close" aria-label="Tutup keranjang">×</button></div>
    <div class="cart-lines">${S.cart.length ? S.cart.map(i => `
      <div class="cl"><div class="n"><span>${esc(i.name)}</span><span>${rp(i.price * i.qty)}</span></div>
        <div class="ctl"><span class="pu">${rp(i.price)} / ${esc(i.unit)}</span>
          <button class="qb" data-act="qminus" data-k="${esc(i.key)}" aria-label="Kurangi">−</button>
          <input class="qty" type="number" inputmode="decimal" step="any" min="0" value="${i.qty}" data-k="${esc(i.key)}" aria-label="Jumlah">
          <button class="qb" data-act="qplus" data-k="${esc(i.key)}" aria-label="Tambah">+</button>
          <button class="rm" data-act="qrm" data-k="${esc(i.key)}" aria-label="Hapus">🗑</button></div></div>`).join('')
      : '<div class="empty" style="font-family:var(--font)">Keranjang kosong.<br>Pilih produk atau scan barcode.</div>'}</div>
    <div class="cart-foot">
      ${tp > 0 ? `<div class="sum"><span>Subtotal</span><span>${rp(sub)}</span></div><div class="sum"><span>Pajak ${tp}%</span><span>${rp(tax)}</span></div>` : ''}
      <div class="sum total"><span>Total</span><span>${rp(sub + tax)}</span></div>
      <div class="row"><button class="btn bad" data-act="cart-clear" ${S.cart.length ? '' : 'disabled'}>Kosongkan</button>
      <button class="btn cta" style="flex:1;min-height:52px;font-size:17px" data-act="checkout" ${S.cart.length ? '' : 'disabled'}>Bayar</button></div></div>`;
  $$('input.qty', el).forEach(inp => inp.addEventListener('change', () => setQty(inp.dataset.k, +inp.value)));
  const fab = $('#fab');
  if (fab) { fab.hidden = !S.cart.length; fab.innerHTML = `<span>${num(cartCount())} item</span><span>${rp(sub + tax)} ›</span>`; }
}
function setQty(key, q) {
  const i = S.cart.find(x => x.key === key); if (!i) return;
  if (!(q > 0)) { S.cart = S.cart.filter(x => x !== i); }
  else {
    const p = S.products.find(x => x.id === i.product_id), src = i.variant_id ? p?.variants.find(v => v.id === i.variant_id) : p;
    if (src && S.settings.allow_negative !== '1' && q > src.stock) { toast(`Stok tersisa ${num(src.stock)}`, 'err'); q = src.stock; }
    i.qty = q;
  }
  saveCart(); renderCart();
}
ACT.qminus = el => { const i = S.cart.find(x => x.key === el.dataset.k); if (i) setQty(i.key, i.qty - 1); };
ACT.qplus = el => { const i = S.cart.find(x => x.key === el.dataset.k); if (i) setQty(i.key, i.qty + 1); };
ACT.qrm = el => setQty(el.dataset.k, 0);
ACT['cart-clear'] = () => { if (confirm('Kosongkan keranjang?')) { S.cart = []; saveCart(); renderCart(); } };
ACT['cart-open'] = () => $('#cart').classList.add('open');
ACT['cart-close'] = () => $('#cart').classList.remove('open');

// scanner USB/Bluetooth (keyboard wedge): ketik di mana saja -> masuk ke kolom cari
document.addEventListener('keydown', e => {
  if (S.view !== 'pos' || !$('#modal').hidden || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  $('#q')?.focus();
});

/* ---------- Scan kamera ---------- */
let scanStream = null, scanTimer = null;
function stopScan() { clearInterval(scanTimer); scanTimer = null; if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; } }
ACT.scan = async () => {
  const m = modal(mhead('Scan barcode') + `<div class="cam"><video id="vid" playsinline muted></video></div>
    <p class="muted" id="scanMsg">Arahkan kamera ke barcode produk.</p>`);
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    $('#scanMsg').textContent = 'Browser ini belum mendukung scan kamera (atau situs belum memakai HTTPS). Gunakan scanner USB/Bluetooth atau ketik kodenya di kolom cari.'; return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const vid = $('#vid'); vid.srcObject = scanStream; await vid.play();
    const det = new BarcodeDetector(); let last = '', lastT = 0;
    scanTimer = setInterval(async () => {
      try {
        const r = await det.detect(vid); if (!r.length) return;
        const code = r[0].rawValue, t = Date.now();
        if (code === last && t - lastT < 2000) return; last = code; lastT = t;
        const hit = findBarcode(code);
        if (hit) { if (hit[0].variants.length && !hit[1]) { stopScan(); closeModal(); pickProduct(hit[0]); } else if (addItem(hit[0], hit[1])) { $('#scanMsg').textContent = '✓ ' + hit[0].name + (hit[1] ? ' - ' + hit[1].name : '') + ' — scan lagi untuk menambah'; } }
        else { beep(false); $('#scanMsg').textContent = 'Barcode ' + code + ' tidak terdaftar'; }
      } catch { }
    }, 350);
  } catch (e) { $('#scanMsg').textContent = 'Kamera tidak bisa dibuka: ' + e.message; }
};

/* ---------- Checkout ---------- */
function coTotals() {
  const C = S.co, sub = cartSub(), dv = +C.discount || 0;
  let d = C.dtype === 'pct' ? Math.round(sub * dv / 100) : Math.round(dv);
  d = Math.max(0, Math.min(d, sub));
  const tax = Math.round((sub - d) * taxPct() / 100);
  return { sub, d, tax, total: sub - d + tax };
}
ACT.checkout = () => {
  if (!S.cart.length) return;
  S.co = { method: 'tunai', paid: '', discount: '', dtype: 'rp' };
  modal(mhead('Pembayaran') + `<div id="coSum" class="sumbox"></div>
    <div class="field" style="margin-top:12px"><label for="coDisc">Diskon</label><div class="row"><input id="coDisc" type="number" inputmode="decimal" min="0" placeholder="0"><select id="coDt" style="width:90px"><option value="rp">Rp</option><option value="pct">%</option></select></div></div>
    <div class="methods" id="coMethods"></div><div id="coPay"></div>
    <div class="row2"><input id="coCust" placeholder="Nama pelanggan (opsional)"><input id="coPhone" inputmode="tel" placeholder="No. WhatsApp (opsional)"></div>
    <button class="btn cta big" id="coGo" data-act="co-submit">Konfirmasi bayar</button>`);
  $('#coDisc').addEventListener('input', e => { S.co.discount = e.target.value; coSum(); coPay(true); });
  $('#coDt').addEventListener('change', e => { S.co.dtype = e.target.value; coSum(); coPay(true); });
  coSum(); coMethods(); coPay(true);
};
function coSum() {
  const t = coTotals(), tp = taxPct();
  $('#coSum').innerHTML = `<div class="sum"><span>Subtotal</span><span>${rp(t.sub)}</span></div>
    ${t.d ? `<div class="sum"><span>Diskon</span><span>− ${rp(t.d)}</span></div>` : ''}
    ${tp ? `<div class="sum"><span>Pajak ${tp}%</span><span>${rp(t.tax)}</span></div>` : ''}
    <div class="sum total"><span>Total</span><span>${rp(t.total)}</span></div>`;
}
function coMethods() {
  $('#coMethods').innerHTML = Object.entries(METHOD).map(([k, v]) => `<button class="${S.co.method === k ? 'on' : ''}" data-act="co-method" data-m="${k}">${v}</button>`).join('');
}
ACT['co-method'] = el => { S.co.method = el.dataset.m; S.co.paid = ''; coMethods(); coPay(true); };
function coPay(full) {
  const C = S.co, t = coTotals(), box = $('#coPay');
  if (C.method === 'tunai') {
    if (full || !$('#coPaid')) {
      const sug = [...new Set([5000, 10000, 20000, 50000, 100000].map(u => Math.ceil(t.total / u) * u).filter(x => x > t.total))].slice(0, 4);
      box.innerHTML = `<div class="paybox"><label for="coPaid" style="font-weight:600;font-size:13px">Uang diterima</label>
        <input id="coPaid" type="number" inputmode="numeric" min="0" value="${esc(C.paid)}" placeholder="0">
        <div class="quick"><button class="btn sm" data-act="quick" data-v="${t.total}">Uang pas</button>${sug.map(s => `<button class="btn sm" data-act="quick" data-v="${s}">${rp(s)}</button>`).join('')}</div>
        <div>Kembalian <span class="change" id="coChange"></span></div></div>`;
      $('#coPaid').addEventListener('input', e => { C.paid = e.target.value; coChange(); });
    }
    coChange();
  } else {
    const txt = { qris: 'Minta pelanggan scan QRIS di bawah, lalu pastikan pembayaran sudah masuk sebelum konfirmasi.', debit: 'Proses di mesin EDC, lalu konfirmasi setelah berhasil.', kredit: 'Proses di mesin EDC, lalu konfirmasi setelah berhasil.', ewallet: 'Pastikan pembayaran e-wallet pelanggan sudah berhasil sebelum konfirmasi.' }[C.method];
    box.innerHTML = `<div class="paybox"><p style="margin:0 0 6px">${txt}</p>${C.method === 'qris' ? (S.settings.qris_image ? `<img class="qris" alt="QRIS toko" src="${esc(S.settings.qris_image)}">` : '<p class="muted" style="margin:0">QRIS toko belum diunggah (Setelan → Toko).</p>') : ''}</div>`;
    $('#coGo').disabled = false;
  }
}
function coChange() {
  const t = coTotals(), paid = +S.co.paid || 0, ch = paid - t.total, el = $('#coChange');
  if (!el) return; el.textContent = paid ? (ch >= 0 ? rp(ch) : 'kurang ' + rp(-ch)) : '–'; el.classList.toggle('short', paid > 0 && ch < 0);
  $('#coGo').disabled = !(paid >= t.total);
}
ACT.quick = el => { S.co.paid = el.dataset.v; $('#coPaid').value = el.dataset.v; coChange(); };
ACT['co-submit'] = async el => {
  if (el.disabled) return; el.disabled = true;
  const C = S.co, t = coTotals();
  const payload = {
    client_id: uuid(), method: C.method, paid: C.method === 'tunai' ? +C.paid : t.total,
    discount: +C.discount || 0, discount_type: C.dtype, customer: $('#coCust').value.trim(), customer_phone: $('#coPhone').value.trim(),
    items: S.cart.map(i => ({ product_id: i.product_id, variant_id: i.variant_id, qty: i.qty })),
  };
  let sale;
  try {
    sale = await api('/sales', { method: 'POST', body: payload });
    if (sale.low_stock?.length) setTimeout(() => toast('Stok menipis: ' + sale.low_stock.map(x => x.name).join(', ')), 600);
  } catch (e) {
    if (!e.network) { toast(e.message, 'err'); el.disabled = false; if (e.status === 409) refreshProducts(); return; }
    // ---- mode offline: simpan antrean, sinkron nanti ----
    payload.offline = true; payload.created_at = nowStr();
    S.queue.push(payload);
    sale = {
      id: 0, invoice: 'OFFLINE-' + payload.client_id.slice(0, 6).toUpperCase(), created_at: payload.created_at, cashier: S.user.name,
      customer: payload.customer, customer_phone: payload.customer_phone, subtotal: t.sub, discount: t.d, tax: t.tax, total: t.total,
      paid: payload.paid, change: payload.paid - t.total, method: C.method, status: 'paid', offline: true,
      items: S.cart.map(i => ({ name: i.name, qty: i.qty, price: i.price })),
    };
    toast('Offline: transaksi disimpan & akan dikirim otomatis', '');
  }
  // kurangi stok lokal
  for (const i of S.cart) {
    const p = S.products.find(x => x.id === i.product_id); if (!p) continue;
    if (i.variant_id) { const v = p.variants.find(x => x.id === i.variant_id); if (v) { v.stock -= i.qty; p.stock = p.variants.reduce((a, x) => a + x.stock, 0); } } else p.stock -= i.qty;
  }
  saveProducts(); saveQueue(); S.cart = []; saveCart(); updateNavBadge();
  showReceipt(sale, true);
  if (S.view === 'pos') { renderGrid(); renderCart(); ACT['cart-close'](); }
  if (!sale.offline) refreshProducts();
};

/* ---------- Struk ---------- */
function receiptHTML(s) {
  const st = S.settings, line = (a, b, cls = '') => `<div class="l ${cls}"><span>${a}</span><span>${b}</span></div>`;
  return `<div class="rc"><h3>${esc(st.store_name || 'Toko')}</h3>
    <p>${esc(st.address || '')}</p>${st.phone ? `<p>Telp ${esc(st.phone)}</p>` : ''}<hr>
    ${line('No', esc(s.invoice))}${line('Tgl', fmtDT(s.created_at))}${line('Kasir', esc(s.cashier))}${s.customer ? line('Pelanggan', esc(s.customer)) : ''}
    ${s.status === 'void' ? '<p class="b">** DIBATALKAN **</p>' : ''}<hr>
    ${s.items.map(i => `<div class="it"><div>${esc(i.name)}</div>${line(num(i.qty) + ' x ' + num(i.price), num(Math.round(i.qty * i.price)))}</div>`).join('')}<hr>
    ${line('Subtotal', num(s.subtotal))}${s.discount ? line('Diskon', '-' + num(s.discount)) : ''}${s.tax ? line('Pajak', num(s.tax)) : ''}
    ${line('TOTAL', num(s.total), 'b')}${line('Bayar (' + METHOD[s.method] + ')', num(s.paid))}${s.method === 'tunai' ? line('Kembali', num(s.change)) : ''}<hr>
    <p>${esc(st.footer || '')}</p>${s.offline ? '<p>(transaksi offline)</p>' : ''}</div>`;
}
function receiptText(s) {
  const st = S.settings, L = [];
  L.push(`*${st.store_name || 'Toko'}*`, st.address || '', '', `No: ${s.invoice}`, `Tgl: ${fmtDT(s.created_at)}`, `Kasir: ${s.cashier}`, '------------------------');
  s.items.forEach(i => L.push(`${i.name}\n  ${num(i.qty)} x ${rp(i.price)} = ${rp(i.qty * i.price)}`));
  L.push('------------------------', `Subtotal: ${rp(s.subtotal)}`);
  if (s.discount) L.push(`Diskon: -${rp(s.discount)}`);
  if (s.tax) L.push(`Pajak: ${rp(s.tax)}`);
  L.push(`*TOTAL: ${rp(s.total)}*`, `Bayar (${METHOD[s.method]}): ${rp(s.paid)}`);
  if (s.method === 'tunai') L.push(`Kembali: ${rp(s.change)}`);
  L.push('', st.footer || '');
  return L.filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
}
function showReceipt(s, isNew) {
  S.sale = s;
  modal(mhead(isNew ? 'Pembayaran berhasil ✓' : 'Detail transaksi') + `<div class="paper">${receiptHTML(s)}</div>
    <div class="row2" style="margin-top:0"><button class="btn pri" data-act="rc-print">Cetak struk</button><button class="btn" data-act="rc-wa">Kirim WhatsApp</button>
    <button class="btn" data-act="rc-mail">Kirim email</button>
    ${isNew ? '<button class="btn cta" data-act="modal-close">Transaksi baru</button>' : (isOwner() && s.status === 'paid' && s.id ? '<button class="btn bad" data-act="rc-void">Batalkan transaksi</button>' : '<button class="btn" data-act="modal-close">Tutup</button>')}</div>
    ${isNew && s.method === 'tunai' ? `<p class="change" style="text-align:center;margin:8px 0 0">Kembalian ${rp(s.change)}</p>` : ''}`);
}
function printHTML(html, page) {
  $('#pageStyle').textContent = `@page{${page}}`;
  $('#printArea').innerHTML = html; setTimeout(() => window.print(), 60);
}
ACT['rc-print'] = () => { const w = S.settings.paper === '80' ? 80 : 58; printHTML(`<div style="width:${w - 8}mm;margin:0 auto">${receiptHTML(S.sale)}</div>`, `size:${w}mm auto;margin:2mm`); };
ACT['rc-wa'] = () => {
  let ph = (S.sale.customer_phone || '').replace(/\D/g, '');
  if (ph.startsWith('0')) ph = '62' + ph.slice(1); else if (ph.startsWith('8')) ph = '62' + ph;
  window.open(`https://wa.me/${ph}?text=${encodeURIComponent(receiptText(S.sale))}`, '_blank', 'noopener');
};
ACT['rc-mail'] = () => { location.href = `mailto:?subject=${encodeURIComponent('Struk ' + S.sale.invoice + ' - ' + (S.settings.store_name || ''))}&body=${encodeURIComponent(receiptText(S.sale).replace(/\*/g, ''))}`; };
ACT['rc-void'] = async () => {
  if (!confirm('Batalkan transaksi ini? Stok akan dikembalikan.')) return;
  try { await api(`/sales/${S.sale.id}/void`, { method: 'POST', body: {} }); toast('Transaksi dibatalkan', 'ok'); closeModal(); await refreshProducts(); if (S.view === 'hist') viewHist(); } catch (e) { toast(e.message, 'err'); }
};

/* ---------- Antrean offline ---------- */
let syncing = false;
async function syncQueue() {
  if (syncing || !S.token || !S.queue.length) return; syncing = true;
  try {
    while (S.queue.length) {
      const p = S.queue[0];
      try { await api('/sales', { method: 'POST', body: p }); S.queue.shift(); }
      catch (e) {
        if (e.network || e.status === 401) break;
        S.failed.push({ ...p, error: e.message }); S.queue.shift();
      }
      saveQueue();
    }
    saveQueue();
    if (!S.queue.length && S.online) { toast('Transaksi offline berhasil disinkronkan', 'ok'); refreshProducts(); }
  } finally { syncing = false; }
}
ACT.queue = () => {
  modal(mhead('Transaksi belum sinkron') + `${S.queue.length ? `<p>${S.queue.length} transaksi menunggu koneksi dan dikirim otomatis.</p>` : ''}
    ${S.failed.map((f, i) => `<div class="card" style="margin-bottom:8px"><b>${fmtDT(f.created_at)}</b> — ${f.items.length} item<br><small style="color:var(--bad)">Gagal: ${esc(f.error)}</small><br>
      <button class="btn sm bad" data-act="failed-del" data-i="${i}" style="margin-top:6px">Hapus</button></div>`).join('')}
    <button class="btn pri big" data-act="sync-now">Coba kirim sekarang</button>`);
};
ACT['sync-now'] = async () => { await syncQueue(); closeModal(); updateNet(); };
ACT['failed-del'] = el => { S.failed.splice(+el.dataset.i, 1); saveQueue(); closeModal(); if (S.failed.length) ACT.queue(); };

/* =============================== RIWAYAT =============================== */
async function viewHist() {
  const t = ymd(new Date());
  $('#view').innerHTML = `<div class="page"><div class="bar">
    ${isOwner() ? `<input type="date" id="hf" value="${t}"><span>s/d</span><input type="date" id="ht" value="${t}">` : '<b>Transaksi hari ini</b>'}
    <button class="btn" id="hgo">Tampilkan</button></div><div id="hlist" class="list"></div></div>`;
  const load = async () => {
    const el = $('#hlist'); el.innerHTML = '<div class="empty">Memuat…</div>';
    try {
      const f = $('#hf')?.value || t, to = $('#ht')?.value || t;
      const d = await api(`/sales?from=${f}&to=${to}`);
      S.hist = d;
      const offs = S.queue.map(p => `<div class="item"><span class="t">Offline · menunggu sinkron</span><span class="a">${p.items.length} item</span><small>${fmtDT(p.created_at)}</small></div>`).join('');
      const sum = d.filter(x => x.status === 'paid').reduce((a, x) => a + x.total, 0);
      el.innerHTML = offs + (d.length ? `<div class="muted">${d.length} transaksi · total ${rp(sum)}</div>` + d.map(s => `
        <button class="item ${s.status === 'void' ? 'void' : ''}" data-act="hist-open" data-id="${s.id}">
          <span class="t">${esc(s.invoice)} ${s.status === 'void' ? '<span class="badge bad">batal</span>' : ''}</span><span class="a">${rp(s.total)}</span>
          <small>${fmtDT(s.created_at)} · ${esc(s.cashier)}${s.customer ? ' · ' + esc(s.customer) : ''}</small><small class="right">${METHOD[s.method]}</small></button>`).join('')
        : '<div class="empty">Belum ada transaksi pada periode ini.</div>');
    } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}${e.network ? '<br>Riwayat butuh koneksi internet.' : ''}</div>`; }
  };
  $('#hgo').onclick = load; load();
}
ACT['hist-open'] = async el => { try { showReceipt(await api('/sales/' + el.dataset.id), false); } catch (e) { toast(e.message, 'err'); } };

/* =============================== PRODUK & STOK =============================== */
function viewProd() {
  $('#view').innerHTML = `<div class="page"><div class="bar">
    <input id="pq" type="search" placeholder="Cari produk…"><label class="toggle"><input type="checkbox" id="plow"> Stok menipis</label>
    <button class="btn" data-act="stock-hist">Riwayat stok</button><button class="btn pri" data-act="prod-new">+ Produk</button></div>
    <div id="plist" class="list"></div></div>`;
  $('#pq').addEventListener('input', renderPList); $('#plow').addEventListener('change', renderPList); renderPList();
}
function renderPList() {
  const q = $('#pq').value.trim().toLowerCase(), low = $('#plow').checked;
  const l = S.products.filter(p => (!q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q) || (p.category || '').toLowerCase().includes(q)) && (!low || (p.min_stock > 0 && p.stock <= p.min_stock)));
  $('#plist').innerHTML = l.length ? l.map(p => {
    const isLow = p.min_stock > 0 && p.stock <= p.min_stock;
    return `<div class="prow"><div><b>${esc(p.name)}</b><br><small>${esc(p.category || 'Tanpa kategori')}${p.barcode ? ' · ' + esc(p.barcode) : ''}${p.variants.length ? ' · ' + p.variants.length + ' varian' : ''}</small></div>
      <div class="right"><b>${p.variants.length ? 'mulai ' + rp(Math.min(...p.variants.map(v => v.price))) : rp(p.price)}</b><br><small>modal ${rp(p.variants.length ? p.variants[0].cost : p.cost)}</small></div>
      <div class="right"><span class="badge ${p.stock <= 0 ? 'bad' : isLow ? 'low' : 'ok'}">${num(p.stock)} ${esc(p.unit)}</span></div>
      <div class="pa"><button class="btn sm" data-act="stock" data-id="${p.id}">Atur stok</button><button class="btn sm" data-act="prod-edit" data-id="${p.id}">Ubah</button><button class="btn sm bad" data-act="prod-del" data-id="${p.id}">Hapus</button></div></div>`;
  }).join('') : '<div class="empty">Tidak ada produk.</div>';
}
const vrow = (v = {}) => `<div class="vrow" data-vid="${v.id || ''}"><input class="vn" placeholder="Nama varian (mis. L Hitam / Pedas)" value="${esc(v.name || '')}">
  <input class="vp" type="number" inputmode="numeric" placeholder="Harga jual" value="${v.price ?? ''}"><input class="vc" type="number" inputmode="numeric" placeholder="Harga modal" value="${v.cost ?? ''}">
  <input class="vs" type="number" inputmode="decimal" step="any" placeholder="Stok" value="${v.stock ?? ''}"><input class="vb" placeholder="Barcode (opsional)" value="${esc(v.barcode || '')}">
  <button class="x" data-act="v-del" aria-label="Hapus varian">×</button></div>`;
function prodForm(p) {
  p = p || { name: '', barcode: '', category: '', price: '', cost: '', stock: '', min_stock: '', unit: 'pcs', variants: [] };
  const cats = [...new Set(S.products.map(x => x.category).filter(Boolean))];
  modal(mhead(p.id ? 'Ubah produk' : 'Produk baru') + `<datalist id="catl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="field"><label>Nama produk</label><input id="fn" value="${esc(p.name)}"></div>
    <div class="row2"><div class="field"><label>Kategori</label><input id="fc" list="catl" value="${esc(p.category)}"></div><div class="field"><label>Satuan</label><input id="fu" value="${esc(p.unit)}"></div></div>
    <div class="field"><label>Barcode (scan atau ketik)</label><input id="fb" inputmode="numeric" value="${esc(p.barcode || '')}"></div>
    <div class="row2"><div class="field"><label>Harga jual</label><input id="fp" type="number" inputmode="numeric" value="${p.price}"></div><div class="field"><label>Harga modal</label><input id="fcost" type="number" inputmode="numeric" value="${p.cost}"></div></div>
    <div class="row2"><div class="field"><label>Stok</label><input id="fs" type="number" inputmode="decimal" step="any" value="${p.variants.length ? '' : p.stock}" ${p.variants.length ? 'disabled' : ''}></div><div class="field"><label>Batas stok menipis</label><input id="fm" type="number" inputmode="decimal" step="any" value="${p.min_stock}"></div></div>
    <h3 style="margin:8px 0">Varian <small>(ukuran, warna, rasa, topping — stok dihitung per varian)</small></h3>
    <div id="vlist">${p.variants.map(vrow).join('')}</div>
    <button class="btn sm" data-act="v-add" style="margin-bottom:14px">+ Tambah varian</button>
    <div class="err" id="ferr"></div><button class="btn pri big" data-act="prod-save" data-id="${p.id || ''}">Simpan</button>`, 'wide');
  setTimeout(() => $('#fn').focus(), 50);
}
ACT['prod-new'] = () => prodForm(); ACT['prod-edit'] = el => prodForm(S.products.find(p => p.id == el.dataset.id));
ACT['v-add'] = () => { $('#vlist').insertAdjacentHTML('beforeend', vrow()); $('#fs').disabled = true; $('#fs').value = ''; };
ACT['v-del'] = el => { el.closest('.vrow').remove(); if (!$$('.vrow').length) $('#fs').disabled = false; };
ACT['prod-save'] = async el => {
  const id = el.dataset.id;
  const body = { name: $('#fn').value, category: $('#fc').value, unit: $('#fu').value, barcode: $('#fb').value, price: $('#fp').value, cost: $('#fcost').value, stock: $('#fs').value, min_stock: $('#fm').value,
    variants: $$('.vrow').map(r => ({ id: r.dataset.vid ? +r.dataset.vid : undefined, name: $('.vn', r).value, price: $('.vp', r).value, cost: $('.vc', r).value, stock: $('.vs', r).value, barcode: $('.vb', r).value })) };
  try { await api(id ? '/products/' + id : '/products', { method: id ? 'PUT' : 'POST', body }); await loadBootstrap(); closeModal(); toast('Produk disimpan', 'ok'); updateNavBadge(); renderPList(); }
  catch (e) { $('#ferr').textContent = e.message; }
};
ACT['prod-del'] = async el => {
  const p = S.products.find(x => x.id == el.dataset.id);
  if (!confirm(`Hapus "${p.name}"? Riwayat penjualan tetap tersimpan.`)) return;
  try { await api('/products/' + p.id, { method: 'DELETE' }); await loadBootstrap(); renderPList(); updateNavBadge(); toast('Produk dihapus', 'ok'); } catch (e) { toast(e.message, 'err'); }
};
ACT.stock = el => {
  const p = S.products.find(x => x.id == el.dataset.id);
  modal(mhead('Atur stok') + `<p><b>${esc(p.name)}</b></p>
    ${p.variants.length ? `<div class="field"><label>Varian</label><select id="sv">${p.variants.map(v => `<option value="${v.id}">${esc(v.name)} (stok ${num(v.stock)})</option>`).join('')}</select></div>` : `<p class="muted">Stok sekarang: ${num(p.stock)} ${esc(p.unit)}</p>`}
    <div class="methods"><button class="on" data-act="smode" data-m="add">Barang masuk (+)</button><button data-act="smode" data-m="set">Stok opname (set)</button><button data-act="smode" data-m="sub">Rusak / hilang (−)</button></div>
    <div class="field"><label id="slabel">Jumlah ditambahkan</label><input id="sq" type="number" inputmode="decimal" step="any" min="0"></div>
    <div class="field"><label>Catatan</label><input id="sn" placeholder="mis. kulakan dari Toko Makmur"></div>
    <div class="err" id="ferr"></div><button class="btn pri big" data-act="stock-save" data-id="${p.id}">Simpan</button>`);
  S.smode = 'add'; setTimeout(() => $('#sq').focus(), 50);
};
ACT.smode = el => { S.smode = el.dataset.m; $$('.methods button').forEach(b => b.classList.toggle('on', b === el)); $('#slabel').textContent = { add: 'Jumlah ditambahkan', set: 'Jumlah stok sebenarnya', sub: 'Jumlah berkurang' }[S.smode]; };
ACT['stock-save'] = async el => {
  const q = +$('#sq').value; if ($('#sq').value === '' || q < 0) { $('#ferr').textContent = 'Isi jumlah dengan benar'; return; }
  const body = { product_id: +el.dataset.id, variant_id: $('#sv') ? +$('#sv').value : null, note: $('#sn').value };
  if (S.smode === 'sub') { body.mode = 'add'; body.qty = -q; body.type = 'rusak'; } else { body.mode = S.smode; body.qty = q; if (S.smode === 'set') body.type = 'opname'; }
  try { await api('/stock/adjust', { method: 'POST', body }); await loadBootstrap(); closeModal(); renderPList(); updateNavBadge(); toast('Stok diperbarui', 'ok'); } catch (e) { $('#ferr').textContent = e.message; }
};
ACT['stock-hist'] = async () => {
  try {
    const d = await api('/stock/moves');
    modal(mhead('Riwayat stok') + `<div class="tblwrap"><table><tr><th>Waktu</th><th>Barang</th><th class="r">Jumlah</th><th>Jenis</th></tr>${d.map(m => `<tr><td>${fmtDT(m.created_at)}</td><td>${esc(m.name)}<br><small>${esc(m.note || '')} ${esc(m.user || '')}</small></td><td class="r">${m.qty > 0 ? '+' : ''}${num(m.qty)}</td><td>${esc(m.type)}</td></tr>`).join('')}</table></div>`, 'wide');
  } catch (e) { toast(e.message, 'err'); }
};

/* =============================== LAPORAN =============================== */
const download = (name, data, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); };
function preset(k) {
  const d = new Date(), t = ymd(d);
  if (k === 'today') return [t, t];
  if (k === 'week') { const s = new Date(d); s.setDate(d.getDate() - 6); return [ymd(s), t]; }
  if (k === 'month') return [`${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`, t];
  return [`${d.getFullYear()}-01-01`, t];
}
function viewReport() {
  const [f, t] = S.rng || preset('month');
  $('#view').innerHTML = `<div class="page"><div class="bar"><div class="seg">
    <button class="btn sm" data-act="rp" data-k="today">Hari ini</button><button class="btn sm" data-act="rp" data-k="week">7 hari</button><button class="btn sm" data-act="rp" data-k="month">Bulan ini</button><button class="btn sm" data-act="rp" data-k="year">Tahun ini</button></div>
    <input type="date" id="rf" value="${f}"><span>s/d</span><input type="date" id="rt" value="${t}"><button class="btn pri" id="rgo">Tampilkan</button></div>
    <div id="rbody"><div class="empty">Memuat…</div></div></div>`;
  $('#rgo').onclick = loadReport; loadReport();
}
ACT.rp = el => { S.rng = preset(el.dataset.k); $('#rf').value = S.rng[0]; $('#rt').value = S.rng[1]; loadReport(); };
async function loadReport() {
  const f = $('#rf').value, t = $('#rt').value; S.rng = [f, t];
  const days = (new Date(t) - new Date(f)) / 864e5;
  try { S.R = await api(`/report?from=${f}&to=${t}&group=${days > 62 ? 'month' : 'day'}`); renderReport(); }
  catch (e) { $('#rbody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function renderReport() {
  const R = S.R, max = Math.max(1, ...R.by_day.map(x => x.omzet));
  const cls = n => n >= 0 ? 'pos-c' : 'neg-c';
  $('#rbody').innerHTML = `<div class="stats">
    <div class="stat hero"><small>Omzet</small><b>${rp(R.omzet)}</b><small>${R.transaksi} transaksi · rata-rata ${rp(R.rata_rata)}</small></div>
    <div class="stat hero"><small>Laba bersih</small><b class="${cls(R.laba_bersih)}">${rp(R.laba_bersih)}</b><small>setelah HPP & pengeluaran</small></div>
    <div class="stat"><small>Laba kotor</small><b>${rp(R.laba_kotor)}</b><small>HPP ${rp(R.hpp)}</small></div>
    <div class="stat"><small>Pengeluaran</small><b>${rp(R.pengeluaran)}</b></div>
    <div class="stat"><small>Arus kas bersih</small><b class="${cls(R.arus_kas)}">${rp(R.arus_kas)}</b><small>masuk ${rp(R.kas_masuk)} · keluar ${rp(R.kas_keluar)}</small></div>
    <div class="stat"><small>Item terjual</small><b>${num(R.item_terjual)}</b><small>diskon ${rp(R.diskon)}</small></div></div>
    <div class="card"><h3>Omzet per ${R.group === 'day' ? 'hari' : 'bulan'}</h3>${R.by_day.length ? `<div class="bars">${R.by_day.map(d => `<div class="bar-c" title="${esc(d.k)}: ${rp(d.omzet)}"><i style="height:${Math.max(2, d.omzet / max * 100)}%"></i>${R.group === 'day' ? d.k.slice(8) : MONTHS[+d.k.slice(5) - 1]}</div>`).join('')}</div>` : '<div class="empty">Tidak ada penjualan.</div>'}</div>
    <div class="cols"><div class="card"><h3>Produk terlaris</h3><div class="tblwrap"><table><tr><th>Produk</th><th class="r">Qty</th><th class="r">Omzet</th><th class="r">Laba</th></tr>${R.top_products.map(p => `<tr><td>${esc(p.name)}</td><td class="r">${num(p.qty)}</td><td class="r">${rp(p.revenue)}</td><td class="r">${rp(p.profit)}</td></tr>`).join('') || '<tr><td colspan=4 class="muted">–</td></tr>'}</table></div></div>
    <div class="card"><h3>Metode pembayaran</h3><table>${R.by_method.map(m => `<tr><td>${METHOD[m.method]}</td><td class="r">${m.n}x</td><td class="r">${rp(m.total)}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table>
      <h3 style="margin-top:14px">Per kasir</h3><table>${R.by_cashier.map(m => `<tr><td>${esc(m.cashier)}</td><td class="r">${m.n}x</td><td class="r">${rp(m.total)}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table>
      <h3 style="margin-top:14px">Pengeluaran per kategori</h3><table>${R.expenses.map(m => `<tr><td>${esc(m.category)}</td><td class="r">${rp(m.total)}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div></div>
    ${R.low_stock.length ? `<div class="card"><h3>⚠ Stok menipis (${R.low_stock.length})</h3><table>${R.low_stock.map(p => `<tr><td>${esc(p.name)}</td><td class="r"><span class="badge low">${num(p.stock)} / ${num(p.min_stock)} ${esc(p.unit)}</span></td></tr>`).join('')}</table></div>` : ''}
    <div class="card"><h3>Ekspor laporan</h3><div class="seg"><button class="btn" data-act="ex-xls">Excel (.xls)</button><button class="btn" data-act="ex-csv">CSV transaksi</button><button class="btn" data-act="ex-pdf">PDF / Cetak</button></div></div>`;
}
async function exportData() {
  const [f, t] = S.rng; return { R: S.R, sales: await api(`/sales?from=${f}&to=${t}&items=1`) };
}
function docHTML(R, sales) {
  const T = (h, rows) => `<table><tr>${h.map(x => `<th>${x}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
  return `<div class="doc"><h2>Laporan ${esc(S.settings.store_name || '')}</h2><p>Periode ${fmtDT(R.from)} s/d ${fmtDT(R.to)}</p>
    ${T(['Ringkasan', 'Nilai (Rp)'], [['Omzet', R.omzet], ['Jumlah transaksi', R.transaksi], ['Diskon', R.diskon], ['Pajak', R.pajak], ['HPP', R.hpp], ['Laba kotor', R.laba_kotor], ['Pengeluaran', R.pengeluaran], ['Laba bersih', R.laba_bersih], ['Arus kas bersih', R.arus_kas]])}
    ${T([R.group === 'day' ? 'Tanggal' : 'Bulan', 'Transaksi', 'Omzet', 'HPP', 'Laba kotor', 'Pengeluaran'], R.by_day.map(d => [d.k, d.n, d.omzet, d.hpp, d.laba, d.biaya]))}
    ${T(['Produk', 'Qty', 'Omzet', 'Laba'], R.top_products.map(p => [esc(p.name), p.qty, p.revenue, p.profit]))}
    ${sales ? T(['Invoice', 'Waktu', 'Kasir', 'Metode', 'Status', 'Total', 'Item'], sales.map(s => [s.invoice, s.created_at, esc(s.cashier), METHOD[s.method], s.status, s.total, esc((s.items || []).map(i => `${i.qty}x ${i.name}`).join('; '))])) : ''}</div>`;
}
ACT['ex-xls'] = async () => { try { const { R, sales } = await exportData(); download(`laporan-${R.from}_${R.to}.xls`, `<html><head><meta charset="utf-8"></head><body>${docHTML(R, sales)}</body></html>`, 'application/vnd.ms-excel'); } catch (e) { toast(e.message, 'err'); } };
ACT['ex-csv'] = async () => {
  try {
    const { R, sales } = await exportData(); const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const rows = [['Invoice', 'Waktu', 'Kasir', 'Pelanggan', 'Metode', 'Status', 'Subtotal', 'Diskon', 'Pajak', 'Total', 'Item'], ...sales.map(s => [s.invoice, s.created_at, s.cashier, s.customer, METHOD[s.method], s.status, s.subtotal, s.discount, s.tax, s.total, (s.items || []).map(i => `${i.qty}x ${i.name}`).join('; ')])];
    download(`transaksi-${R.from}_${R.to}.csv`, '\ufeff' + rows.map(r => r.map(q).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  } catch (e) { toast(e.message, 'err'); }
};
ACT['ex-pdf'] = async () => { try { const { R, sales } = await exportData(); toast('Pilih "Simpan sebagai PDF" pada dialog cetak'); printHTML(docHTML(R, sales), 'size:A4;margin:12mm'); } catch (e) { toast(e.message, 'err'); } };

/* =============================== PENGELUARAN =============================== */
async function viewExp() {
  const [f, t] = preset('month');
  $('#view').innerHTML = `<div class="page"><div class="card"><h3>Catat pengeluaran</h3>
    <div class="row2"><input type="date" id="ed" value="${ymd(new Date())}"><input id="ec" list="ecl" placeholder="Kategori (sewa, listrik, gaji…)"></div>
    <datalist id="ecl"><option>Sewa</option><option>Listrik & air</option><option>Gaji</option><option>Transport</option><option>Kulakan non-stok</option><option>Lainnya</option></datalist>
    <div class="row2"><input id="ea" type="number" inputmode="numeric" placeholder="Nominal (Rp)"><input id="en" placeholder="Catatan"></div>
    <div class="err" id="ferr"></div><button class="btn pri" data-act="exp-add">Simpan</button></div>
    <div class="bar"><input type="date" id="xf" value="${f}"><span>s/d</span><input type="date" id="xt" value="${t}"><button class="btn" id="xgo">Tampilkan</button></div><div id="xlist" class="list"></div></div>`;
  const load = async () => {
    try {
      const d = await api(`/expenses?from=${$('#xf').value}&to=${$('#xt').value}`);
      $('#xlist').innerHTML = d.length ? `<div class="muted">Total ${rp(d.reduce((a, x) => a + x.amount, 0))}</div>` + d.map(x => `<div class="item"><span class="t">${esc(x.category)}</span><span class="a">${rp(x.amount)}</span><small>${fmtDT(x.date)} · ${esc(x.note || '')}</small><button class="btn sm bad" data-act="exp-del" data-id="${x.id}" style="justify-self:end">Hapus</button></div>`).join('') : '<div class="empty">Belum ada pengeluaran pada periode ini.</div>';
    } catch (e) { $('#xlist').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  S.expLoad = load; $('#xgo').onclick = load; load();
}
ACT['exp-add'] = async () => {
  try { await api('/expenses', { method: 'POST', body: { date: $('#ed').value, category: $('#ec').value || 'Lainnya', amount: $('#ea').value, note: $('#en').value } }); $('#ea').value = ''; $('#en').value = ''; $('#ferr').textContent = ''; toast('Pengeluaran dicatat', 'ok'); S.expLoad(); }
  catch (e) { $('#ferr').textContent = e.message; }
};
ACT['exp-del'] = async el => { if (!confirm('Hapus catatan ini?')) return; try { await api('/expenses/' + el.dataset.id, { method: 'DELETE' }); S.expLoad(); } catch (e) { toast(e.message, 'err'); } };

/* =============================== SETELAN =============================== */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (S.view === 'set') viewSet(); });
async function viewSet() {
  const st = S.settings, o = isOwner();
  $('#view').innerHTML = `<div class="page"><div class="card"><h3>Akun: ${esc(S.user.name)} <span class="badge">${o ? 'Pemilik' : 'Kasir'}</span></h3>
    <div class="seg"><button class="btn" data-act="pw">Ganti password</button>${installEvt ? '<button class="btn cta" data-act="install">Pasang aplikasi di perangkat</button>' : ''}<button class="btn bad" data-act="logout">Keluar</button></div></div>
    ${o ? `<div class="card"><h3>Toko & struk</h3>
      <div class="field"><label>Nama toko</label><input id="s_store_name" value="${esc(st.store_name)}"></div>
      <div class="field"><label>Alamat</label><input id="s_address" value="${esc(st.address)}"></div>
      <div class="row2"><div class="field"><label>Telepon</label><input id="s_phone" value="${esc(st.phone)}"></div><div class="field"><label>Pajak / PPN (%)</label><input id="s_tax_percent" type="number" step="any" min="0" value="${esc(st.tax_percent)}"></div></div>
      <div class="field"><label>Pesan di bawah struk</label><input id="s_footer" value="${esc(st.footer)}"></div>
      <div class="row2"><div class="field"><label>Lebar kertas printer</label><select id="s_paper"><option value="58" ${st.paper !== '80' ? 'selected' : ''}>58 mm</option><option value="80" ${st.paper === '80' ? 'selected' : ''}>80 mm</option></select></div>
      <div class="field"><label>Jual saat stok kosong</label><select id="s_allow_negative"><option value="0" ${st.allow_negative !== '1' ? 'selected' : ''}>Tidak boleh</option><option value="1" ${st.allow_negative === '1' ? 'selected' : ''}>Boleh</option></select></div></div>
      <div class="field"><label>Gambar QRIS toko</label><input type="file" id="s_qris" accept="image/*"><div id="qprev">${st.qris_image ? `<img class="qris" alt="QRIS" src="${esc(st.qris_image)}" style="margin:8px 0 0">` : ''}</div></div>
      <button class="btn pri" data-act="set-save">Simpan pengaturan</button></div>
    <div class="card"><h3>Pengguna & hak akses</h3><div id="ulist"></div><button class="btn" data-act="user-new" style="margin-top:10px">+ Tambah pengguna</button>
      <p class="muted" style="margin-bottom:0">Pemilik: akses penuh (produk, laporan, pembatalan, pengaturan). Kasir: hanya transaksi dan riwayat miliknya hari ini.</p></div>
    <div class="card"><h3>Cadangan data</h3><p class="muted" style="margin-top:0">Unduh salinan database secara berkala dan simpan di tempat aman.</p><button class="btn" data-act="backup">Unduh backup (.db)</button></div>` : ''}</div>`;
  if (o) loadUsers();
}
ACT.logout = () => doLogout(true);
ACT.install = async () => { if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; viewSet(); } };
ACT.pw = () => modal(mhead('Ganti password') + `<div class="field"><label>Password lama</label><input id="pw0" type="password" autocomplete="current-password"></div><div class="field"><label>Password baru (min. 6 karakter)</label><input id="pw1" type="password" autocomplete="new-password"></div><div class="err" id="ferr"></div><button class="btn pri big" data-act="pw-save">Simpan</button>`);
ACT['pw-save'] = async () => { try { await api('/me/password', { method: 'POST', body: { old: $('#pw0').value, new: $('#pw1').value } }); closeModal(); toast('Password diubah', 'ok'); } catch (e) { $('#ferr').textContent = e.message; } };
ACT['set-save'] = async () => {
  const body = {}; ['store_name', 'address', 'phone', 'tax_percent', 'footer', 'paper', 'allow_negative'].forEach(k => body[k] = $('#s_' + k).value);
  if (S.newQris !== undefined) body.qris_image = S.newQris;
  try { S.settings = await api('/settings', { method: 'PUT', body }); LS.set('ks_settings', S.settings); S.newQris = undefined; $('#brand').textContent = S.settings.store_name; toast('Pengaturan disimpan', 'ok'); } catch (e) { toast(e.message, 'err'); }
};
document.addEventListener('change', e => {
  if (e.target.id !== 's_qris' || !e.target.files[0]) return;
  const img = new Image(), url = URL.createObjectURL(e.target.files[0]);
  img.onload = () => {
    const sc = Math.min(1, 640 / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    S.newQris = c.toDataURL('image/png'); $('#qprev').innerHTML = `<img class="qris" alt="QRIS" src="${S.newQris}" style="margin:8px 0 0">`; URL.revokeObjectURL(url);
    toast('Klik "Simpan pengaturan" untuk menerapkan');
  };
  img.src = url;
});
async function loadUsers() {
  try {
    S.users = await api('/users');
    $('#ulist').innerHTML = `<table>${S.users.map(u => `<tr><td><b>${esc(u.name)}</b><br><small>@${esc(u.username)}</small></td><td>${u.role === 'owner' ? 'Pemilik' : 'Kasir'}${u.active ? '' : ' <span class="badge bad">nonaktif</span>'}</td><td class="r"><button class="btn sm" data-act="user-edit" data-id="${u.id}">Ubah</button></td></tr>`).join('')}</table>`;
  } catch (e) { $('#ulist').textContent = e.message; }
}
function userForm(u) {
  u = u || { username: '', name: '', role: 'kasir', active: 1 };
  modal(mhead(u.id ? 'Ubah pengguna' : 'Pengguna baru') + `
    <div class="field"><label>Username</label><input id="uu" value="${esc(u.username)}" ${u.id ? 'disabled' : ''} autocapitalize="none"></div>
    <div class="field"><label>Nama</label><input id="un" value="${esc(u.name)}"></div>
    <div class="field"><label>Peran</label><select id="ur"><option value="kasir" ${u.role === 'kasir' ? 'selected' : ''}>Kasir</option><option value="owner" ${u.role === 'owner' ? 'selected' : ''}>Pemilik</option></select></div>
    <div class="field"><label>${u.id ? 'Password baru (kosongkan jika tidak diubah)' : 'Password (min. 6 karakter)'}</label><input id="up" type="password" autocomplete="new-password"></div>
    ${u.id ? `<label class="toggle"><input type="checkbox" id="ua" ${u.active ? 'checked' : ''}> Akun aktif</label>` : ''}
    <div class="err" id="ferr"></div><button class="btn pri big" data-act="user-save" data-id="${u.id || ''}">Simpan</button>`);
}
ACT['user-new'] = () => userForm(); ACT['user-edit'] = el => userForm(S.users.find(u => u.id == el.dataset.id));
ACT['user-save'] = async el => {
  const id = el.dataset.id, body = { username: $('#uu').value, name: $('#un').value, role: $('#ur').value, password: $('#up').value, active: $('#ua') ? $('#ua').checked : true };
  try { await api(id ? '/users/' + id : '/users', { method: id ? 'PUT' : 'POST', body }); closeModal(); toast('Pengguna disimpan', 'ok'); loadUsers(); } catch (e) { $('#ferr').textContent = e.message; }
};
ACT.backup = async () => {
  try { const r = await api('/backup', { raw: true }); const b = await r.blob(); download(`kasir-smart-backup-${ymd(new Date())}.db`, b, 'application/octet-stream'); } catch (e) { toast(e.message, 'err'); }
};

/* ---------- start ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => { });
setInterval(() => { refreshProducts(); syncQueue(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshProducts(); syncQueue(); } });
boot();
