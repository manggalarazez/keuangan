/* =========================================================
   Catatan Keuangan — app.js  (Vanilla JS, tanpa build)
   Frontend PWA yang terhubung ke Google Sheets via Apps Script.
   ========================================================= */
'use strict';

const APP_VERSION = '1.0.0';

/* ---------------- Penyimpanan lokal ---------------- */
const LS = {
  cfg: 'kw.cfg', tx: 'kw.tx', queue: 'kw.queue', settings: 'kw.settings', sheetCats: 'kw.sheetCats',
  lastSync: 'kw.lastSync', pin: 'kw.pin', settingsDirty: 'kw.settingsDirty', ui: 'kw.ui'
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('Gagal simpan', k, e); } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* abaikan */ } }
};

const DEFAULT_SETTINGS = {
  budgetBulanan: 3000000,
  budgetMingguan: 750000,
  awalSiklus: 1,
  kategori: {
    pemasukan: ['Gaji', 'Bonus', 'Freelance', 'Hasil Investasi', 'Lainnya'],
    pengeluaran: ['Makanan & Minuman', 'Transportasi', 'Belanja', 'Tagihan & Utilitas',
      'Hiburan', 'Kesehatan', 'Pendidikan', 'Sosial & Donasi', 'Lainnya']
  }
};

/* ---------------- State ---------------- */
const S = {
  cfg: null, tx: [], queue: [], settings: null, sheetCats: {}, pin: null,
  lastSync: 0, settingsDirty: false, syncError: null, pulling: false,
  view: 'home', homePeriod: 'month', statsPeriod: 'month', custom: { home: null, stats: null },
  hist: { q: '', jenis: 'all', kat: 'all', per: 'all', limit: 80 }
};

function loadState() {
  S.cfg = store.get(LS.cfg, null);
  S.tx = store.get(LS.tx, []);
  S.queue = store.get(LS.queue, []).map(o => Object.assign(o, { inflight: false }));
  S.settings = normSettings(store.get(LS.settings, DEFAULT_SETTINGS));
  S.sheetCats = store.get(LS.sheetCats, {});
  S.pin = store.get(LS.pin, null);
  S.lastSync = store.get(LS.lastSync, 0);
  S.settingsDirty = store.get(LS.settingsDirty, false);
  const ui = store.get(LS.ui, {});
  if (ui.homePeriod && ui.homePeriod !== 'custom') S.homePeriod = ui.homePeriod;
}
const saveTx = () => store.set(LS.tx, S.tx);
const saveQueue = () => store.set(LS.queue, S.queue.map(o => { const c = Object.assign({}, o); delete c.inflight; return c; }));
const saveSettingsLocal = () => { store.set(LS.settings, S.settings); store.set(LS.settingsDirty, S.settingsDirty); };

function normSettings(s) {
  s = s || {};
  const k = s.kategori || {};
  return {
    budgetBulanan: Math.max(0, Number(s.budgetBulanan ?? DEFAULT_SETTINGS.budgetBulanan) || 0),
    budgetMingguan: Math.max(0, Number(s.budgetMingguan ?? DEFAULT_SETTINGS.budgetMingguan) || 0),
    awalSiklus: Math.min(28, Math.max(1, Number(s.awalSiklus) || 1)),
    kategori: {
      pemasukan: Array.isArray(k.pemasukan) && k.pemasukan.length ? k.pemasukan : DEFAULT_SETTINGS.kategori.pemasukan.slice(),
      pengeluaran: Array.isArray(k.pengeluaran) && k.pengeluaran.length ? k.pengeluaran : DEFAULT_SETTINGS.kategori.pengeluaran.slice()
    }
  };
}

/* ---------------- Ikon (SVG garis) ---------------- */
const IC = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
  chart: '<path d="M21 12.5A9 9 0 1 1 11.5 3v9.5z"/><path d="M15 3.3A9 9 0 0 1 20.7 9H15z"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  cloudUp: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5"/><path d="M12 12v8M9 15l3-3 3 3"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="3" y="8" width="18" height="12" rx="2.5"/><path d="M16 14h2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>',
  tag: '<path d="M3 12V4h8l9.5 9.5-8 8z"/><circle cx="7.5" cy="8" r="1.3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="M14 5 7 12l7 7"/><path d="M7 12h0"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/>',
  del: '<path d="M21 5H9l-6 7 6 7h12z"/><path d="m17 9-6 6M11 9l6 6"/>'
};
const ico = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${IC[n] || ''}</svg>`;

/* ---------------- Utilitas umum ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rp = n => 'Rp ' + nf.format(Math.round(Number(n) || 0));
const rpSigned = (n, jenis) => (jenis === 'pemasukan' ? '+' : '−') + rp(n);
function rpShort(n) {
  n = Math.round(Number(n) || 0);
  const a = Math.abs(n);
  const f = (v, s) => (Math.round(v * 10) / 10).toString().replace('.', ',') + ' ' + s;
  if (a >= 1e9) return f(n / 1e9, 'M');
  if (a >= 1e6) return f(n / 1e6, 'jt');
  if (a >= 1e3) return f(n / 1e3, 'rb');
  return String(n);
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

/* ---------------- Tanggal ---------------- */
const BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const diffDays = (a, b) => Math.round((parseYmd(ymd(b)) - parseYmd(ymd(a))) / 864e5);
const fmtDate = s => { const d = parseYmd(s); return `${d.getDate()} ${BLN[d.getMonth()]} ${d.getFullYear()}`; };
const fmtDateShort = d => `${d.getDate()} ${BLN[d.getMonth()]}`;
function dayLabel(s) {
  const d = parseYmd(s), t = today(), diff = diffDays(d, t);
  if (diff === 0) return 'Hari ini';
  if (diff === 1) return 'Kemarin';
  return `${HARI[d.getDay()]}, ${d.getDate()} ${BLN[d.getMonth()]}${d.getFullYear() !== t.getFullYear() ? ' ' + d.getFullYear() : ''}`;
}
const mkRange = (from, to, label) => ({ from, to, fromS: ymd(from), toS: ymd(to), label });
function weekRange(d = today()) {
  const from = addDays(d, -((d.getDay() + 6) % 7)); // Senin
  const to = addDays(from, 6);
  return mkRange(from, to, `${fmtDateShort(from)} – ${fmtDateShort(to)}`);
}
function cycleRange(d = today()) {
  const s = S.settings.awalSiklus || 1;
  const from = d.getDate() >= s ? new Date(d.getFullYear(), d.getMonth(), s) : new Date(d.getFullYear(), d.getMonth() - 1, s);
  const to = addDays(new Date(from.getFullYear(), from.getMonth() + 1, s), -1);
  const label = s === 1 ? `${BULAN[from.getMonth()]} ${from.getFullYear()}` : `${fmtDateShort(from)} – ${fmtDateShort(to)}`;
  return mkRange(from, to, label);
}
function periodRange(key, custom) {
  const t = today();
  switch (key) {
    case 'today': return mkRange(t, t, 'Hari ini');
    case 'week': return Object.assign(weekRange(t), {});
    case 'month': return cycleRange(t);
    case 'lastmonth': return cycleRange(addDays(cycleRange(t).from, -1));
    case 'last3': { const c = cycleRange(t); let f = c.from; for (let i = 0; i < 2; i++) f = cycleRange(addDays(f, -1)).from; return mkRange(f, c.to, '3 bulan terakhir'); }
    case 'year': return mkRange(new Date(t.getFullYear(), 0, 1), new Date(t.getFullYear(), 11, 31), 'Tahun ' + t.getFullYear());
    case 'custom': return custom ? mkRange(parseYmd(custom.from), parseYmd(custom.to), `${fmtDate(custom.from)} – ${fmtDate(custom.to)}`) : cycleRange(t);
    default: return null; // semua
  }
}
const inRange = (t, r) => !r || (t.tanggal >= r.fromS && t.tanggal <= r.toS);
function elapsedDays(r) {
  const t = today();
  if (!r) {
    const first = S.tx.reduce((m, x) => (x.tanggal < m ? x.tanggal : m), ymd(t));
    return diffDays(parseYmd(first), t) + 1;
  }
  const end = r.to < t ? r.to : t;
  if (end < r.from) return diffDays(r.from, r.to) + 1;
  return diffDays(r.from, end) + 1;
}

/* ---------------- Kategori & tampilan ---------------- */
const PALETTE = ['#6366F1', '#14B8A6', '#F59E0B', '#EC4899', '#0EA5E9', '#8B5CF6', '#10B981', '#F43F5E', '#64748B', '#84CC16', '#06B6D4', '#A855F7'];
const CAT_EMOJI = [
  [/makan|minum|kuliner|food|jajan/i, '🍜'], [/transport|bensin|kendaraan/i, '🛵'], [/belanja|shopping/i, '🛍️'],
  [/tagihan|utilitas|listrik/i, '💡'], [/hiburan|rekreasi/i, '🎬'], [/kesehatan|medis/i, '💊'],
  [/pendidikan|edukasi|sekolah/i, '📚'], [/sosial|donasi|amal|zakat/i, '🤝'], [/gaji/i, '💼'],
  [/bonus|thr/i, '🎁'], [/freelance|proyek/i, '💻'], [/investasi|dividen|tabungan/i, '📈'],
  [/rumah|sewa|kos/i, '🏠'], [/cicilan|utang|hutang|kredit/i, '💳'], [/pakaian|fashion/i, '👕'], [/anak|keluarga/i, '👪']
];
function catEmoji(name, jenis) {
  const hit = CAT_EMOJI.find(([re]) => re.test(name || ''));
  return hit ? hit[1] : (jenis === 'pemasukan' ? '💰' : '📦');
}
function catColor(name, jenis = 'pengeluaran') {
  const list = categoriesFor(jenis);
  let i = list.indexOf(name);
  if (i < 0) { i = 0; for (const ch of String(name)) i = (i * 31 + ch.charCodeAt(0)) >>> 0; }
  return PALETTE[i % PALETTE.length];
}
/** Daftar kategori: ikuti dropdown di Sheets bila ada, jika tidak pakai pengaturan aplikasi. */
function categoriesFor(jenis) {
  const fromSheet = S.sheetCats && Array.isArray(S.sheetCats[jenis]) && S.sheetCats[jenis].length ? S.sheetCats[jenis] : null;
  return fromSheet || S.settings.kategori[jenis] || [];
}
const catsLocked = jenis => !!(S.sheetCats && Array.isArray(S.sheetCats[jenis]) && S.sheetCats[jenis].length);

/* ---------------- Smart Text Input ---------------- */
// Setiap aturan: jenis, pola nama kategori tujuan, dan kata kunci (dipisah "|").
const SMART_RULES = [
  { j: 'pengeluaran', cat: /makan|minum|kuliner|food|jajan/i, kw: 'makan|minum|sarapan|nasi|kopi|ngopi|teh|jus|bakso|mie|mi ayam|soto|sate|geprek|padang|warteg|warung|resto|restoran|cafe|kafe|snack|jajan|cemilan|camilan|gofood|grabfood|shopeefood|martabak|roti|pizza|burger|kfc|mcd|mcdonald|starbucks|boba|susu|gorengan|seblak|pecel|coto|konro|pallubasa|es krim|es teh|air mineral|katering|catering|lauk|buah|kue|dimsum|ayam|ikan|bebek' },
  { j: 'pengeluaran', cat: /transport|bensin|kendaraan/i, kw: 'bensin|bbm|pertalite|pertamax|solar|isi minyak|ojek|ojol|gojek|goride|gocar|grab|grabbike|grabcar|maxim|taksi|taxi|parkir|tol|etoll|e-toll|bus|busway|transjakarta|kereta|krl|mrt|lrt|pesawat|tiket pesawat|angkot|damri|kapal|ferry|pelni|servis motor|servis mobil|bengkel|ganti oli|oli|cuci motor|cuci mobil|ban|travel' },
  { j: 'pengeluaran', cat: /belanja|shopping/i, kw: 'belanja|beli|baju|celana|sepatu|sandal|tas|shopee|tokopedia|tokped|lazada|tiktok shop|blibli|indomaret|alfamart|alfamidi|supermarket|minimarket|hypermart|pasar|sayur|beras|minyak goreng|gula|telur|galon|elpiji|lpg|gas elpiji|sabun|sampo|shampo|odol|pasta gigi|deterjen|tisu|skincare|kosmetik|perabot|elektronik|gadget|aksesoris|kebutuhan rumah' },
  { j: 'pengeluaran', cat: /tagihan|utilitas|listrik/i, kw: 'listrik|pln|token listrik|token|pdam|tagihan|pulsa|kuota|paket data|internet|wifi|indihome|biznet|first media|bpjs|cicilan|angsuran|kredit|kos|kost|sewa|kontrakan|asuransi|pajak|pbb|iuran|langganan|ipl|biaya admin|admin bank' },
  { j: 'pengeluaran', cat: /hiburan|rekreasi/i, kw: 'nonton|bioskop|cinema|xxi|cgv|netflix|spotify|youtube premium|disney|vidio|game|top up|voucher game|steam|liburan|wisata|rekreasi|karaoke|konser|hotel|staycation|jalan-jalan|jalan jalan|nongkrong|hobi' },
  { j: 'pengeluaran', cat: /kesehatan|medis/i, kw: 'obat|dokter|apotek|apotik|klinik|rumah sakit|puskesmas|vitamin|suplemen|periksa|cek darah|lab|gigi|kacamata|masker|terapi|pijat|gym|fitness' },
  { j: 'pengeluaran', cat: /pendidikan|edukasi|sekolah/i, kw: 'buku|kursus|kuliah|ukt|spp|sekolah|les|seminar|webinar|pelatihan|sertifikasi|ujian|alat tulis|fotokopi|print|udemy|coursera' },
  { j: 'pengeluaran', cat: /sosial|donasi|amal|zakat/i, kw: 'sedekah|zakat|infak|infaq|donasi|kondangan|sumbangan|arisan|amplop|kado|traktir|kolekte|perpuluhan|persembahan' },
  { j: 'pemasukan', cat: /gaji/i, kw: 'gaji|gajian|salary|upah' },
  { j: 'pemasukan', cat: /bonus|thr/i, kw: 'bonus|thr|insentif|tunjangan|komisi' },
  { j: 'pemasukan', cat: /freelance|proyek|project/i, kw: 'freelance|proyek|project|fee|honor|honorarium|jasa|klien|client' },
  { j: 'pemasukan', cat: /investasi|dividen/i, kw: 'dividen|bunga deposito|bunga|imbal hasil|kupon|reksadana|saham|profit|cuan' },
  { j: 'pemasukan', cat: /lain/i, kw: 'jual|penjualan|terima|diterima|dapat|dapet|cashback|refund|transfer masuk|uang masuk|pemasukan|kiriman' }
];
const LOW_WEIGHT = { beli: 2, token: 3, tol: 4 };
// Kompilasi pola: kata pendek (<4 huruf) harus utuh, kata panjang boleh berimbuhan (makan -> makanan).
SMART_RULES.forEach(r => {
  r.words = r.kw.split('|').map(w => {
    const e = w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    const tail = w.length < 4 ? '(?![a-z0-9])' : '';
    return { w, re: new RegExp('(?:^|[^a-z0-9])' + e + tail, 'i'), weight: LOW_WEIGHT[w] ?? w.length };
  });
});
const hasWord = (text, w) => new RegExp('(?:^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'), 'i').test(text);

function extractAmount(text) {
  const re = /(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)(?:\s*(ribu|rbu|rb|k|juta|jt))?(?![a-z0-9])/gi;
  let best = null, m;
  while ((m = re.exec(text))) {
    let num = m[1];
    const suf = (m[2] || '').toLowerCase();
    let v;
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(num)) { // 25.000 / 1.250.000 = pemisah ribuan
      v = Number(num.replace(/[.,]/g, ''));
    } else {
      v = Number(num.replace(',', '.'));
    }
    if (suf === 'rb' || suf === 'ribu' || suf === 'rbu' || suf === 'k') v *= 1e3;
    if (suf === 'jt' || suf === 'juta') v *= 1e6;
    v = Math.round(v);
    if (isFinite(v) && v > 0 && (!best || v > best.value)) best = { value: v, text: m[0], index: m.index };
  }
  return best;
}

function parseSmart(text, forcedJenis) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (!forcedJenis && raw.startsWith('+')) forcedJenis = 'pemasukan';
  const lower = raw.toLowerCase();
  const amt = extractAmount(raw);

  let tanggal = null;
  if (/(?:^|\s)kemarin(?:\s|$)/i.test(lower)) tanggal = ymd(addDays(today(), -1));

  // Skor aturan kata kunci
  let best = null;
  for (const r of SMART_RULES) {
    if (forcedJenis && r.j !== forcedJenis) continue;
    let score = 0;
    for (const w of r.words) if (w.re.test(lower)) score += w.weight;
    if (score > 0 && (!best || score > best.score)) best = { rule: r, j: r.j, score };
  }
  // Nama kategori yang ditulis langsung (termasuk kategori buatan sendiri)
  for (const j of (forcedJenis ? [forcedJenis] : ['pengeluaran', 'pemasukan'])) {
    for (const cat of categoriesFor(j)) {
      const words = cat.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
      const full = cat.toLowerCase();
      const score = hasWord(lower, full) ? 20 : (words.some(w => hasWord(lower, w)) ? 12 : 0);
      if (score && (!best || score > best.score)) best = { direct: cat, j, score };
    }
  }
  const jenis = forcedJenis || (best ? best.j : 'pengeluaran');
  let kategori = null;
  if (best) {
    if (best.direct) kategori = best.direct;
    else {
      const list = categoriesFor(jenis);
      kategori = list.find(c => best.rule.cat.test(c)) || list.find(c => /lain/i.test(c)) || null;
    }
  }
  let ket = raw;
  if (amt) ket = ket.slice(0, amt.index) + ' ' + ket.slice(amt.index + amt.text.length);
  ket = ket.replace(/^\s*\+/, '').replace(/(?:^|\s)(kemarin|hari ini)(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s,.\-:]+|[\s,.\-:]+$/g, '').trim();
  if (ket) ket = ket.charAt(0).toUpperCase() + ket.slice(1);
  return { nominal: amt ? amt.value : 0, kategori, jenis, keterangan: ket, tanggal, guessed: !!best };
}

/* ---------------- Komunikasi dengan Apps Script ---------------- */
class ApiError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

async function apiCall(action, payload = {}, cfg = S.cfg) {
  if (!cfg || cfg.mode !== 'sheets') throw new ApiError('Belum terhubung ke Google Sheets.', 'NOCONF');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    // text/plain = "simple request": tidak memicu preflight CORS yang tidak didukung Apps Script.
    res = await fetch(cfg.url, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.token, action, payload })
    });
  } catch (e) {
    throw new ApiError(navigator.onLine ? 'Server tidak bisa dihubungi. Periksa URL & akses "Siapa saja".' : 'Kamu sedang offline.', 'NET');
  } finally { clearTimeout(timer); }
  let j;
  try { j = await res.json(); } catch (e) {
    throw new ApiError('Respons server tidak valid. Pastikan URL Web App diakhiri /exec dan aksesnya "Siapa saja".', 'BAD');
  }
  if (!j.ok) throw new ApiError(j.error || 'Terjadi kesalahan di server.', j.code || 'SERVER');
  return j.data;
}

const opId = op => (op.type === 'delete' ? op.id : op.tx.id);
function enqueue(op) {
  const id = opId(op);
  const i = S.queue.findIndex(o => opId(o) === id && !o.inflight);
  if (i >= 0) {
    const prev = S.queue[i];
    if (op.type === 'update' && prev.type === 'add') prev.tx = op.tx;
    else if (op.type === 'delete' && prev.type === 'add') S.queue.splice(i, 1);
    else S.queue[i] = op;
  } else {
    S.queue.push(op);
  }
  saveQueue();
}
const isPending = id => S.queue.some(o => opId(o) === id);

let qBusy = false;
async function processQueue() {
  if (qBusy || !S.cfg || S.cfg.mode !== 'sheets' || !S.queue.length) return { ok: true };
  qBusy = true; renderSyncPill();
  let result = { ok: true }, needPull = false;
  try {
    while (S.queue.length) {
      const op = S.queue[0];
      op.inflight = true;
      try {
        const res = await apiCall(op.type, op.type === 'delete' ? { id: op.id } : op.tx);
        S.queue.splice(S.queue.indexOf(op), 1);
        if (op.type !== 'delete') {
          const t = S.tx.find(x => x.id === op.tx.id);
          if (t && !isPending(t.id)) { delete t._pending; if (res && res.seq) t.seq = res.seq; }
        }
        S.syncError = null;
      } catch (e) {
        op.inflight = false;
        if (e.code === 'NET' || e.code === 'BAD') { S.syncError = 'offline'; result = { ok: false, offline: true, msg: e.message }; break; }
        if (e.code === 'AUTH') { S.syncError = 'auth'; result = { ok: false, msg: e.message }; break; }
        // Ditolak server (mis. validasi). Buang operasi lalu ambil ulang data asli dari Sheets.
        S.queue.splice(S.queue.indexOf(op), 1);
        result = { ok: false, msg: e.message };
        needPull = true;
      }
      saveQueue(); saveTx();
    }
  } finally {
    qBusy = false; saveQueue(); saveTx(); renderSyncPill(); refreshView();
  }
  if (needPull) await pull(true);
  return result;
}

async function pull(silent) {
  if (!S.cfg || S.cfg.mode !== 'sheets' || S.pulling) return;
  S.pulling = true; setRefreshSpin(true);
  try {
    if (S.settingsDirty) {
      const info = await apiCall('saveSettings', S.settings);
      S.settingsDirty = false; applyInfo(info);
    }
    const d = await apiCall('sync');
    applyInfo(d.info);
    let list = (d.transaksi || []).map(normTx).filter(t => t.id);
    for (const op of S.queue) { // timpa dengan perubahan yang belum terkirim
      if (op.type === 'delete') list = list.filter(t => t.id !== op.id);
      else {
        const i = list.findIndex(t => t.id === op.tx.id);
        const t = Object.assign({}, op.tx, { _pending: true });
        if (i >= 0) list[i] = t; else list.push(t);
      }
    }
    S.tx = list; S.lastSync = Date.now(); S.syncError = null;
    saveTx(); store.set(LS.lastSync, S.lastSync);
    refreshView();
  } catch (e) {
    S.syncError = e.code === 'NET' || e.code === 'BAD' ? 'offline' : e.code === 'AUTH' ? 'auth' : 'error';
    if (!silent) toast(e.message, 'err', 4000);
    refreshView();
  } finally {
    S.pulling = false; setRefreshSpin(false); renderSyncPill();
  }
}

function applyInfo(info) {
  if (!info) return;
  S.sheetCats = info.kategoriSheet || {};
  store.set(LS.sheetCats, S.sheetCats);
  if (!S.settingsDirty && info.settings) { S.settings = normSettings(info.settings); saveSettingsLocal(); }
}

const normTx = t => ({
  id: String(t.id || ''), jenis: t.jenis === 'pemasukan' ? 'pemasukan' : 'pengeluaran', tanggal: String(t.tanggal || ymd(today())),
  kategori: String(t.kategori || 'Lainnya'), keterangan: String(t.keterangan || ''), nominal: Number(t.nominal) || 0, seq: Number(t.seq) || 0
});

/* ---------------- Operasi transaksi ---------------- */
async function commitTx(tx, isEdit) {
  const before = { m: budgetEval('month').status, w: budgetEval('week').status };
  const clean = normTx(tx);
  const i = S.tx.findIndex(t => t.id === clean.id);
  const local = S.cfg.mode !== 'sheets';
  if (i >= 0) { clean.seq = S.tx[i].seq; S.tx[i] = Object.assign(clean, local ? {} : { _pending: true }); }
  else { clean.seq = Date.now(); S.tx.push(Object.assign(clean, local ? {} : { _pending: true })); }
  saveTx(); refreshView();

  const t = toast(local ? 'Tersimpan di HP' : 'Menyimpan ke Google Sheets…', local ? 'ok' : 'load', local ? 2200 : 0);
  if (!local) {
    enqueue({ type: isEdit ? 'update' : 'add', tx: Object.assign({}, clean, { _pending: undefined }) });
    const r = await processQueue();
    if (r.ok) t.update(isEdit ? 'Perubahan tersimpan ke Sheets' : 'Tersimpan ke Google Sheets', 'ok', 2200);
    else if (r.offline) t.update('Tersimpan di HP · dikirim otomatis saat online', 'warn', 3500);
    else t.update('Gagal menyimpan: ' + r.msg, 'err', 5000);
  }
  budgetAlert(before);
}

async function removeTx(id) {
  const i = S.tx.findIndex(t => t.id === id);
  if (i < 0) return;
  const before = S.tx[i];
  S.tx.splice(i, 1); saveTx(); refreshView();
  if (S.cfg.mode !== 'sheets') { toast('Transaksi dihapus', 'ok'); return; }
  enqueue({ type: 'delete', id, jenis: before.jenis });
  const t = toast('Menghapus dari Sheets…', 'load', 0);
  const r = await processQueue();
  if (r.ok) t.update('Transaksi dihapus', 'ok', 2000);
  else if (r.offline) t.update('Dihapus di HP · disinkronkan saat online', 'warn', 3500);
  else t.update('Gagal menghapus: ' + r.msg, 'err', 5000);
}

/* ---------------- Perhitungan ---------------- */
const sortTx = list => list.slice().sort((a, b) => b.tanggal.localeCompare(a.tanggal) || (b.seq || 0) - (a.seq || 0));
const sumOf = (list, jenis) => list.reduce((s, t) => s + (t.jenis === jenis ? t.nominal : 0), 0);
function byCategory(list, jenis = 'pengeluaran') {
  const m = new Map();
  list.forEach(t => { if (t.jenis === jenis) m.set(t.kategori, (m.get(t.kategori) || 0) + t.nominal); });
  return Array.from(m, ([kategori, total]) => ({ kategori, total })).sort((a, b) => b.total - a.total);
}

function budgetEval(kind) {
  const budget = kind === 'month' ? S.settings.budgetBulanan : S.settings.budgetMingguan;
  const r = kind === 'month' ? cycleRange() : weekRange();
  const spent = sumOf(S.tx.filter(t => inRange(t, r)), 'pengeluaran');
  const totalDays = diffDays(r.from, r.to) + 1;
  const elapsed = Math.min(totalDays, diffDays(r.from, today()) + 1);
  const remain = totalDays - elapsed + 1; // termasuk hari ini
  const pct = budget > 0 ? spent / budget : 0;
  const ideal = budget * elapsed / totalDays;
  const pace = ideal > 0 ? spent / ideal : 0;
  const projection = elapsed > 0 ? spent / elapsed * totalDays : spent;
  const sisa = budget - spent;
  const perHari = Math.max(0, sisa) / Math.max(1, remain);
  let status = 'none', msg = '';
  const hari = remain === 1 ? 'hari ini' : `${remain} hari ke depan`;
  if (budget > 0) {
    if (pct >= 1) {
      status = 'over';
      msg = `Sudah lewat ${rp(spent - budget)} dari budget. Tunda pengeluaran yang tidak mendesak untuk ${hari}.`;
    } else if (pct >= 0.8) {
      status = 'warn';
      msg = `${Math.round(pct * 100)}% budget terpakai. Batasi maksimal ${rp(perHari)}/hari untuk ${hari}.`;
    } else {
      status = 'safe';
      if (pace > 1.15 && spent > 0) msg = `Masih aman, tapi lajumu ${Math.round((pace - 1) * 100)}% lebih cepat dari jalur. Proyeksi akhir periode ${rp(projection)}.`;
      else if (pace < 0.85 && elapsed > 1) msg = `Hemat! ${rp(ideal - spent)} di bawah jalur ideal. Jatah aman ${rp(perHari)}/hari.`;
      else msg = `Sesuai jalur. Jatah aman ${rp(perHari)}/hari untuk ${hari}.`;
    }
  }
  return { kind, budget, r, spent, pct, ideal, pace, projection, sisa, perHari, remain, elapsed, totalDays, status, msg };
}
const STATUS_TXT = { safe: 'Aman', warn: 'Mendekati Batas', over: 'Over-Budget', none: 'Belum diatur' };

function budgetAlert(before) {
  const rank = { none: 0, safe: 0, warn: 1, over: 2 };
  const now = { m: budgetEval('month'), w: budgetEval('week') };
  const hit = [['m', 'bulanan'], ['w', 'mingguan']].find(([k]) => rank[now[k].status] > rank[before[k]]);
  if (!hit) return;
  const e = now[hit[0]];
  setTimeout(() => toast(e.status === 'over'
    ? `Budget ${hit[1]} terlampaui (${Math.round(e.pct * 100)}%)`
    : `Budget ${hit[1]} sudah ${Math.round(e.pct * 100)}% · sisa ${rp(e.sisa)}`, e.status === 'over' ? 'err' : 'warn', 4500), 900);
}

/* ---------------- Toast & dialog ---------------- */
function toast(msg, type = 'ok', ms = 2600) {
  const host = $('#toast-host');
  const el = document.createElement('div');
  let timer;
  const icon = t => t === 'load' ? '<span class="spinner" style="width:16px;height:16px;border-radius:50%;border:2.5px solid rgba(255,255,255,.35);border-top-color:#fff;animation:spin .8s linear infinite;flex-shrink:0"></span>'
    : ico(t === 'ok' ? 'check' : t === 'err' ? 'alert' : t === 'warn' ? 'alert' : 'info', 'sm');
  const set = (m, t) => { el.className = 'toast ' + t; el.innerHTML = icon(t) + `<span>${esc(m)}</span>`; };
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  const arm = d => { clearTimeout(timer); if (d) timer = setTimeout(close, d); };
  set(msg, type); host.appendChild(el); arm(ms);
  while (host.children.length > 3) host.firstChild.remove();
  return { update(m, t = 'ok', d = 2600) { set(m, t); arm(d); }, close };
}

function confirmDialog({ title, msg, ok = 'Ya', cancel = 'Batal', danger = false }) {
  return new Promise(resolve => {
    const w = $('#dialog');
    w.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true"><h3>${esc(title)}</h3><p>${msg}</p>
      <div class="acts"><button class="btn ghost" data-r="0">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div></div>`;
    w.hidden = false;
    const done = v => { w.hidden = true; w.innerHTML = ''; resolve(v); };
    w.onclick = e => { const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); else if (e.target === w) done(false); };
  });
}

/* ---------------- Bottom sheet ---------------- */
let sheetOpen = false;
function openSheet(html, onMount) {
  const sh = $('#sheet'), bd = $('#sheet-backdrop');
  sh.classList.remove('closing');
  sh.innerHTML = '<div class="sheet-grip"></div>' + html;
  sh.hidden = false; bd.hidden = false;
  if (!sheetOpen) { try { history.pushState({ sheet: true }, ''); } catch (e) { /* abaikan */ } }
  sheetOpen = true;
  document.body.style.overflow = 'hidden';
  if (onMount) onMount(sh);
}
function closeSheet(fromPop) {
  if (!sheetOpen) return;
  sheetOpen = false;
  const sh = $('#sheet'), bd = $('#sheet-backdrop');
  sh.classList.add('closing');
  setTimeout(() => { if (!sheetOpen) { sh.hidden = true; bd.hidden = true; sh.innerHTML = ''; } }, 240);
  document.body.style.overflow = '';
  if (!fromPop && history.state && history.state.sheet) { try { history.back(); } catch (e) { /* abaikan */ } }
}
window.addEventListener('popstate', () => { if (sheetOpen) closeSheet(true); });

/* ---------------- Navigasi & render ---------------- */
const NAV = { home: ['home', 'Beranda'], history: ['list', 'Riwayat'], stats: ['chart', 'Statistik'], settings: ['settings', 'Atur'] };
function renderNav() {
  $$('.nav-btn').forEach(b => {
    const [i, l] = NAV[b.dataset.nav];
    b.innerHTML = ico(i) + `<span>${l}</span>`;
    b.classList.toggle('on', b.dataset.nav === S.view);
  });
  $('.fab').innerHTML = ico('plus');
}
function go(view) {
  S.view = view;
  renderNav();
  render(true);
  window.scrollTo({ top: 0 });
}
function render(animate) {
  const v = $('#view');
  const fn = { home: renderHome, history: renderHistory, stats: renderStats, settings: renderSettings }[S.view] || renderHome;
  v.innerHTML = fn();
  if (animate) { v.style.animation = 'none'; void v.offsetWidth; v.style.animation = ''; }
  if (S.view === 'history') bindHistory();
  renderSyncPill();
}
let refreshQueued = false;
function refreshView() {
  if ($('#app').hidden || refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    if (S.view === 'history') { renderHistList(); return; } // jaga fokus kolom pencarian
    const y = window.scrollY; render(false); window.scrollTo(0, y);
  });
}
function setRefreshSpin(on) { $$('[data-action="sync"]').forEach(b => b.classList.toggle('spin', on)); }

function syncPillHtml() {
  if (!S.cfg) return '';
  if (S.cfg.mode !== 'sheets') return `<span class="pill off"><span class="dot"></span>Mode lokal</span>`;
  const n = S.queue.length;
  if (S.syncError === 'auth') return `<span class="pill err"><span class="dot"></span>Token salah</span>`;
  if (S.syncError === 'offline' || !navigator.onLine) return `<span class="pill off"><span class="dot"></span>Offline${n ? ' · ' + n + ' antre' : ''}</span>`;
  if (n) return `<span class="pill pending"><span class="dot"></span>${n} menunggu kirim</span>`;
  if (S.syncError) return `<span class="pill err"><span class="dot"></span>Gagal sinkron</span>`;
  if (S.lastSync) { const d = new Date(S.lastSync); return `<span class="pill"><span class="dot"></span>Sinkron ${pad(d.getHours())}.${pad(d.getMinutes())}</span>`; }
  return `<span class="pill pending"><span class="dot"></span>Memuat…</span>`;
}
function renderSyncPill() { $$('[data-sync-pill]').forEach(el => { el.innerHTML = syncPillHtml(); }); }

const greet = () => { const h = new Date().getHours(); return h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 18 ? 'Selamat sore' : 'Selamat malam'; };

function txItem(t) {
  const c = catColor(t.kategori, t.jenis);
  return `<button class="tx" data-action="edit-tx" data-id="${esc(t.id)}">
    <span class="cat-ava" style="background:${c}1A">${catEmoji(t.kategori, t.jenis)}</span>
    <span class="mid"><span class="t" style="display:block">${esc(t.keterangan || t.kategori)}</span>
      <span class="d">${t._pending ? `<span class="flag" title="Belum terkirim">${ico('cloudUp', 'xs')}</span>` : ''}${esc(t.kategori)} · ${dayLabel(t.tanggal)}</span></span>
    <span class="amt num ${t.jenis === 'pemasukan' ? 'inc' : 'exp'}">${rpSigned(t.nominal, t.jenis)}</span>
  </button>`;
}

function emptyState(title, text, withBtn = true) {
  return `<div class="empty"><div class="art">🪙</div><h3>${esc(title)}</h3><p>${esc(text)}</p>
    ${withBtn ? `<button class="btn primary sm" data-action="open-add">${ico('plus', 'sm')} Tambah transaksi</button>` : ''}</div>`;
}
function skeletonList(n = 4) {
  return Array.from({ length: n }, () => `<div style="display:flex;gap:12px;align-items:center;padding:12px 4px"><div class="skel" style="width:42px;height:42px;border-radius:14px"></div><div style="flex:1"><div class="skel" style="height:14px;width:60%"></div><div class="skel" style="height:11px;width:35%;margin-top:8px"></div></div><div class="skel" style="height:14px;width:70px"></div></div>`).join('');
}
const isFirstLoad = () => S.cfg && S.cfg.mode === 'sheets' && !S.lastSync && !S.tx.length && !S.syncError;

const PERIOD_CHIPS = [['today', 'Hari ini'], ['week', 'Minggu ini'], ['month', 'Bulan ini'], ['custom', 'Custom']];
function periodChips(scope, current, chips = PERIOD_CHIPS) {
  return `<div class="chips ${scope === 'home' ? 'chips-grid' : ''}" role="tablist">${chips.map(([k, l]) =>
    `<button class="chip ${current === k ? 'on' : ''}" data-action="period" data-scope="${scope}" data-k="${k}">${k === 'custom' ? ico('calendar', 'xs') : ''}${l}</button>`).join('')}</div>`;
}

/* ---------- Beranda ---------- */
function renderHome() {
  const r = periodRange(S.homePeriod, S.custom.home);
  const list = S.tx.filter(t => inRange(t, r));
  const inc = sumOf(list, 'pemasukan'), exp = sumOf(list, 'pengeluaran'), net = inc - exp;
  const recent = sortTx(S.tx).slice(0, 6);
  const cats = byCategory(list);
  const days = elapsedDays(r);
  const avg = exp / Math.max(1, days);
  const bm = budgetEval('month'), bw = budgetEval('week');

  const banners = [];
  if (S.syncError === 'auth') banners.push(`<div class="banner over">${ico('lock')}<div><b>Token tidak cocok</b>Data tidak bisa disinkronkan. Periksa token di menu Atur.<br><button class="act" data-action="open-conn">Perbaiki koneksi</button></div></div>`);
  const worst = [bm, bw].find(e => e.status === 'over') || [bm, bw].find(e => e.status === 'warn');
  if (worst) banners.push(`<div class="banner ${worst.status}">${ico('alert')}<div><b>Budget ${worst.kind === 'month' ? 'bulanan' : 'mingguan'}: ${STATUS_TXT[worst.status]}</b>${esc(worst.msg)}</div></div>`);
  const todayCount = S.tx.filter(t => t.tanggal === ymd(today())).length;
  if (!todayCount && new Date().getHours() >= 18 && S.tx.length) banners.push(`<div class="banner info">${ico('info')}<div><b>Belum ada catatan hari ini</b>Ada pengeluaran yang terlewat? Catat sekarang selagi ingat.<br><button class="act" data-action="open-add">Catat sekarang</button></div></div>`);

  return `
  <div class="topbar">
    <div><h1>${greet()} 👋</h1><div class="sub" data-sync-pill></div></div>
    <button class="icon-btn ${S.pulling ? 'spin' : ''}" data-action="sync" aria-label="Sinkronkan">${ico('refresh')}</button>
  </div>
  ${banners.slice(0, 2).join('')}
  <section class="hero" aria-label="Ringkasan">
    <div class="label">Saldo bersih · ${esc(r.label)}</div>
    <div class="big num">${net < 0 ? '−' : ''}${rp(Math.abs(net))}</div>
    <div class="hero-split">
      <div class="hero-box"><div class="k">${ico('down', 'xs')} Pemasukan</div><div class="v num">${rp(inc)}</div></div>
      <div class="hero-box"><div class="k">${ico('up', 'xs')} Pengeluaran</div><div class="v num">${rp(exp)}</div></div>
    </div>
    ${periodChips('home', S.homePeriod, [['today', 'Hari'], ['week', 'Minggu'], ['month', 'Bulan'], ['custom', 'Custom']])}
  </section>

  <div class="section-title"><h2>Budget</h2><button class="link-btn" data-action="open-budget">Atur</button></div>
  ${budgetCard(bm)}${budgetCard(bw)}
  ${bm.budget > 0 || bw.budget > 0 ? '<div class="hint" style="margin:8px 4px 0">Garis tegak pada bar = batas ideal sampai hari ini.</div>' : ''}

  <div class="section-title"><h2>Insight ${esc(r.label.toLowerCase())}</h2></div>
  <div class="grid2">
    <div class="mini"><div class="k">Rata-rata harian</div><div class="v num">${rp(avg)}</div><div class="s">${days} hari dihitung</div></div>
    <div class="mini"><div class="k">Kategori terbesar</div><div class="v">${cats[0] ? catEmoji(cats[0].kategori) + ' ' + esc(cats[0].kategori) : '–'}</div><div class="s num">${cats[0] ? rp(cats[0].total) + ' · ' + Math.round(cats[0].total / Math.max(1, exp) * 100) + '%' : 'Belum ada pengeluaran'}</div></div>
  </div>

  <div class="section-title"><h2>Transaksi terbaru</h2>${S.tx.length ? '<button class="link-btn" data-nav-go="history">Lihat semua</button>' : ''}</div>
  <div class="card" style="padding:4px 12px">
    ${isFirstLoad() ? skeletonList() : recent.length ? `<div class="tx-list">${recent.map(txItem).join('')}</div>` : emptyState('Belum ada transaksi', 'Ketuk tombol + lalu ketik misalnya "Makan siang 25rb".')}
  </div>`;
}

function budgetCard(e) {
  const name = e.kind === 'month' ? 'Budget bulanan' : 'Budget mingguan';
  if (e.budget <= 0) {
    return `<div class="card"><div class="budget-head"><div><div class="ttl">${name}</div><div class="rng">${esc(e.r.label)}</div></div><span class="badge none">${STATUS_TXT.none}</span></div>
      <p class="budget-msg">Tetapkan batas agar aplikasi bisa mengingatkan saat pengeluaran mendekati batas.</p>
      <button class="btn ghost sm" style="margin-top:10px" data-action="open-budget">${ico('target', 'sm')} Atur budget</button></div>`;
  }
  const w = Math.min(100, e.pct * 100), paceX = Math.min(100, e.elapsed / e.totalDays * 100);
  return `<div class="card">
    <div class="budget-head"><div><div class="ttl">${name}</div><div class="rng">${esc(e.r.label)}</div></div><span class="badge ${e.status}">${STATUS_TXT[e.status]}</span></div>
    <div class="budget-amt"><span class="a num">${rp(e.spent)}</span><span class="b num">dari ${rp(e.budget)} · ${Math.round(e.pct * 100)}%</span></div>
    <div class="bar" role="progressbar" aria-valuenow="${Math.round(e.pct * 100)}" aria-valuemin="0" aria-valuemax="100"><div class="fill ${e.status}" style="width:${w}%"></div><span class="pace" style="left:calc(${paceX}% - 1px)"></span></div>
    <div class="budget-meta"><span class="num">${e.sisa >= 0 ? 'Sisa ' + rp(e.sisa) : 'Lebih ' + rp(-e.sisa)}</span><span>${e.remain} hari lagi</span></div>
    <div class="budget-msg">${esc(e.msg)}</div>
  </div>`;
}

/* ---------- Riwayat ---------- */
const HIST_PER = [['all', 'Semua waktu'], ['month', 'Bulan ini'], ['lastmonth', 'Bulan lalu'], ['week', 'Minggu ini'], ['last3', '3 bulan terakhir'], ['year', 'Tahun ini']];
function renderHistory() {
  const h = S.hist;
  const allCats = Array.from(new Set([...categoriesFor('pengeluaran'), ...categoriesFor('pemasukan'), ...S.tx.map(t => t.kategori)]));
  return `
  <div class="topbar"><div><h1>Riwayat</h1><div class="sub" data-sync-pill></div></div>
    <button class="icon-btn ${S.pulling ? 'spin' : ''}" data-action="sync" aria-label="Sinkronkan">${ico('refresh')}</button></div>
  <label class="search">${ico('search', 'sm')}<input id="hist-q" type="search" placeholder="Cari keterangan, kategori, nominal…" value="${esc(h.q)}" autocomplete="off" enterkeyhint="search"></label>
  <div class="chips" style="margin-top:10px">${[['all', 'Semua'], ['pengeluaran', 'Pengeluaran'], ['pemasukan', 'Pemasukan']].map(([k, l]) =>
    `<button class="chip ${h.jenis === k ? 'on' : ''}" data-action="hist-jenis" data-k="${k}">${l}</button>`).join('')}</div>
  <div class="filters">
    <select id="hist-kat" aria-label="Filter kategori"><option value="all">Semua kategori</option>${allCats.map(c => `<option ${h.kat === c ? 'selected' : ''} value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
    <select id="hist-per" aria-label="Filter periode">${HIST_PER.map(([k, l]) => `<option ${h.per === k ? 'selected' : ''} value="${k}">${l}</option>`).join('')}</select>
  </div>
  <div id="hist-list"></div>`;
}
function bindHistory() {
  const q = $('#hist-q');
  q.addEventListener('input', () => { S.hist.q = q.value; S.hist.limit = 80; renderHistList(); });
  $('#hist-kat').addEventListener('change', e => { S.hist.kat = e.target.value; S.hist.limit = 80; renderHistList(); });
  $('#hist-per').addEventListener('change', e => { S.hist.per = e.target.value; S.hist.limit = 80; renderHistList(); });
  renderHistList();
}
function renderHistList() {
  const el = $('#hist-list');
  if (!el) return;
  const h = S.hist, r = periodRange(h.per);
  const q = h.q.trim().toLowerCase();
  const qNum = q.replace(/[^\d]/g, '');
  let list = S.tx.filter(t => inRange(t, r) && (h.jenis === 'all' || t.jenis === h.jenis) && (h.kat === 'all' || t.kategori === h.kat));
  if (q) list = list.filter(t => (t.keterangan + ' ' + t.kategori + ' ' + fmtDate(t.tanggal)).toLowerCase().includes(q) || (qNum && String(t.nominal).includes(qNum)));
  list = sortTx(list);
  const inc = sumOf(list, 'pemasukan'), exp = sumOf(list, 'pengeluaran');
  if (isFirstLoad()) { el.innerHTML = `<div class="card" style="margin-top:14px;padding:4px 12px">${skeletonList(6)}</div>`; return; }
  if (!list.length) {
    el.innerHTML = `<div class="card" style="margin-top:14px">${S.tx.length ? emptyState('Tidak ditemukan', 'Coba ubah kata kunci atau filter.', false) : emptyState('Riwayat masih kosong', 'Transaksi yang kamu catat akan muncul di sini.')}</div>`;
    return;
  }
  const shown = list.slice(0, h.limit);
  const groups = [];
  shown.forEach(t => { const g = groups[groups.length - 1]; if (g && g.d === t.tanggal) g.items.push(t); else groups.push({ d: t.tanggal, items: [t] }); });
  el.innerHTML = `
    <div class="summary-strip"><span>${list.length} transaksi</span><span class="num"><b class="inc">+${rpShort(inc)}</b> · <b class="exp">−${rpShort(exp)}</b></span></div>
    <div class="card" style="margin-top:8px;padding:0 12px 4px">
      ${groups.map(g => {
        const net = sumOf(g.items, 'pemasukan') - sumOf(g.items, 'pengeluaran');
        return `<div class="day-head"><span>${dayLabel(g.d)}</span><span class="num">${net >= 0 ? '+' : '−'}${rp(Math.abs(net))}</span></div><div class="tx-list">${g.items.map(txItem).join('')}</div>`;
      }).join('')}
    </div>
    ${list.length > h.limit ? `<button class="btn ghost" style="margin-top:12px" data-action="hist-more">Tampilkan lebih banyak (${list.length - h.limit})</button>` : ''}`;
}

/* ---------- Statistik ---------- */
const STATS_CHIPS = [['week', 'Minggu ini'], ['month', 'Bulan ini'], ['last3', '3 bulan'], ['year', 'Tahun ini'], ['custom', 'Custom']];
function renderStats() {
  const r = periodRange(S.statsPeriod, S.custom.stats);
  const list = S.tx.filter(t => inRange(t, r));
  const exp = sumOf(list, 'pengeluaran'), inc = sumOf(list, 'pemasukan');
  const cats = byCategory(list);
  const days = elapsedDays(r);
  const biggest = list.filter(t => t.jenis === 'pengeluaran').sort((a, b) => b.nominal - a.nominal)[0];
  const savingRate = inc > 0 ? Math.round((inc - exp) / inc * 100) : null;

  // Bandingkan dengan periode sebelumnya pada hari yang setara
  let compare = '';
  if (S.statsPeriod === 'month' || S.statsPeriod === 'week') {
    const prev = S.statsPeriod === 'month' ? cycleRange(addDays(r.from, -1)) : weekRange(addDays(r.from, -7));
    const prevEnd = addDays(prev.from, days - 1);
    const pr = mkRange(prev.from, prevEnd < prev.to ? prevEnd : prev.to);
    const pExp = sumOf(S.tx.filter(t => inRange(t, pr)), 'pengeluaran');
    if (pExp > 0) {
      const ch = Math.round((exp - pExp) / pExp * 100);
      const word = S.statsPeriod === 'month' ? 'bulan lalu' : 'minggu lalu';
      compare = `<div class="banner ${ch > 10 ? 'warn' : 'info'}" style="margin-top:12px">${ico(ch > 0 ? 'up' : 'down')}<div><b>${ch > 0 ? 'Naik' : ch < 0 ? 'Turun' : 'Sama'} ${Math.abs(ch)}% dibanding ${word}</b>Pada ${days} hari pertama, ${word} kamu mengeluarkan ${rp(pExp)}; sekarang ${rp(exp)}.</div></div>`;
    }
  }

  return `
  <div class="topbar"><div><h1>Statistik</h1><div class="sub">${esc(r.label)}</div></div>
    <button class="icon-btn ${S.pulling ? 'spin' : ''}" data-action="sync" aria-label="Sinkronkan">${ico('refresh')}</button></div>
  ${periodChips('stats', S.statsPeriod, STATS_CHIPS)}
  ${compare}
  <div class="grid2" style="margin-top:14px">
    <div class="mini"><div class="k">Total pengeluaran</div><div class="v num exp">${rp(exp)}</div><div class="s">${list.filter(t => t.jenis === 'pengeluaran').length} transaksi</div></div>
    <div class="mini"><div class="k">Rata-rata harian</div><div class="v num">${rp(exp / Math.max(1, days))}</div><div class="s">dari ${days} hari</div></div>
    <div class="mini"><div class="k">Transaksi terbesar</div><div class="v num">${biggest ? rp(biggest.nominal) : '–'}</div><div class="s">${biggest ? esc(biggest.keterangan || biggest.kategori) : 'Belum ada'}</div></div>
    <div class="mini"><div class="k">Rasio tabungan</div><div class="v num ${savingRate == null ? '' : savingRate >= 0 ? 'inc' : 'exp'}">${savingRate == null ? '–' : savingRate + '%'}</div><div class="s">${savingRate == null ? 'Belum ada pemasukan' : 'dari pemasukan periode ini'}</div></div>
  </div>

  <div class="section-title"><h2>Pengeluaran per kategori</h2></div>
  <div class="card">${cats.length ? donutBlock(cats, exp) : emptyState('Belum ada pengeluaran', 'Grafik akan muncul setelah ada transaksi pada periode ini.', false)}</div>
  ${cats.length ? `<div class="card cat-rank" style="margin-top:12px">${cats.map(c => {
    const col = catColor(c.kategori);
    return `<div class="r"><span class="cat-ava" style="background:${col}1A">${catEmoji(c.kategori)}</span>
      <div><div class="nm"><span>${esc(c.kategori)}</span><span class="num">${rp(c.total)}</span></div><div class="track"><i style="width:${c.total / cats[0].total * 100}%;background:${col}"></i></div></div>
      <span class="num muted" style="font-size:12px;font-weight:700">${Math.round(c.total / exp * 100)}%</span></div>`;
  }).join('')}</div>` : ''}

  <div class="section-title"><h2>Rekap mingguan</h2><span class="muted" style="font-size:12px">8 minggu terakhir</span></div>
  <div class="card chart">${weeklyChart()}</div>

  <div class="section-title"><h2>Rekap bulanan</h2><span class="muted" style="font-size:12px">6 periode terakhir</span></div>
  <div class="card chart">${monthlyChart()}</div>`;
}

function donutBlock(cats, total) {
  const R = 54, C = 2 * Math.PI * R;
  const top = cats.slice(0, 6);
  const rest = cats.slice(6).reduce((s, c) => s + c.total, 0);
  if (rest) top.push({ kategori: 'Lainnya (gabungan)', total: rest, merged: true });
  let acc = 0;
  const gap = top.length > 1 ? 2 : 0;
  const segs = top.map(c => {
    const len = Math.max(0, c.total / total * C - gap);
    const col = c.merged ? '#CBD5E1' : catColor(c.kategori);
    const s = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${col}" stroke-width="18" stroke-linecap="butt" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}" transform="rotate(-90 70 70)"/>`;
    acc += c.total / total * C;
    return s;
  }).join('');
  return `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 140 140" role="img" aria-label="Diagram pengeluaran per kategori">
      <circle cx="70" cy="70" r="${R}" fill="none" stroke="#EEF1F7" stroke-width="18"/>${segs}
      <text x="70" y="66" text-anchor="middle" font-size="16" font-weight="800" fill="#0F172A">${rpShort(total)}</text>
      <text x="70" y="84" text-anchor="middle" font-size="10" fill="#94A3B8">pengeluaran</text>
    </svg>
    <div class="legend">${top.map(c => `<div class="row"><span class="sw" style="background:${c.merged ? '#CBD5E1' : catColor(c.kategori)}"></span><span class="nm">${esc(c.kategori)}</span><span class="pc num">${Math.round(c.total / total * 100)}%</span></div>`).join('')}</div>
  </div>`;
}

function barChart({ labels, series, line, lineLabel, id }) {
  const W = 340, H = 190, pl = 6, pr = 6, pt = 22, pb = 28;
  const n = labels.length, g = series.length;
  const max = Math.max(1, ...series.flatMap(s => s.values), line || 0) * 1.12;
  const gw = (W - pl - pr) / n, gap = 3;
  const bw = Math.min(g === 1 ? 24 : 14, (gw * 0.72 - gap * (g - 1)) / g);
  const yOf = v => H - pb - (v / max) * (H - pt - pb);
  let bars = '';
  labels.forEach((lab, i) => {
    const x0 = pl + i * gw + (gw - (bw * g + gap * (g - 1))) / 2;
    series.forEach((s, k) => {
      const v = s.values[i] || 0, y = yOf(v), h = Math.max(v ? 2 : 0, H - pb - y);
      const col = typeof s.color === 'function' ? s.color(v, i) : s.color;
      const op = s.dimPast && i < n - 1 ? 0.55 : 1;
      bars += `<rect x="${(x0 + k * (bw + gap)).toFixed(1)}" y="${(H - pb - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="${col}" opacity="${op}"><title>${esc(lab)}: ${rp(v)}</title></rect>`;
      if (g === 1 && v) bars += `<text x="${(x0 + bw / 2).toFixed(1)}" y="${(H - pb - h - 6).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="#475569">${rpShort(v)}</text>`;
    });
    bars += `<text x="${(pl + i * gw + gw / 2).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="9.5" fill="${i === n - 1 ? '#0F172A' : '#94A3B8'}" font-weight="${i === n - 1 ? 700 : 500}">${esc(lab)}</text>`;
  });
  let ln = '';
  if (line > 0) {
    const y = yOf(line).toFixed(1);
    ln = `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="#F0446A" stroke-width="1.4" stroke-dasharray="5 4"><title>${esc(lineLabel)} ${rp(line)}</title></line>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(id)}"><line x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}" stroke="#E9ECF4"/>${bars}${ln}</svg>`;
}

function weeklyChart() {
  const labels = [], vals = [];
  let w = weekRange();
  const ranges = [];
  for (let i = 0; i < 8; i++) { ranges.unshift(w); w = weekRange(addDays(w.from, -1)); }
  ranges.forEach(r => { labels.push(fmtDateShort(r.from)); vals.push(sumOf(S.tx.filter(t => inRange(t, r)), 'pengeluaran')); });
  const b = S.settings.budgetMingguan;
  if (!vals.some(Boolean)) return emptyState('Belum ada data', 'Rekap mingguan muncul setelah ada pengeluaran.', false);
  const avg = vals.reduce((a, c) => a + c, 0) / vals.filter(Boolean).length;
  return barChart({ id: 'Rekap mingguan', labels, series: [{ values: vals, color: v => (b > 0 && v > b ? '#F0446A' : '#6A5CFF'), dimPast: true }], line: b, lineLabel: 'Budget' }) +
    `<div class="legend-inline"><span><i style="background:#6A5CFF"></i>Dalam budget</span><span><i style="background:#F0446A"></i>Melewati budget</span>${b > 0 ? `<span><i class="dash"></i>Budget ${rpShort(b)}</span>` : ''}</div>
    <div class="hint">Rata-rata ${rp(avg)} per minggu (minggu yang ada transaksinya).</div>`;
}

function monthlyChart() {
  const ranges = [];
  let c = cycleRange();
  for (let i = 0; i < 6; i++) { ranges.unshift(c); c = cycleRange(addDays(c.from, -1)); }
  const rows = ranges.map(r => {
    const l = S.tx.filter(t => inRange(t, r));
    const lbl = S.settings.awalSiklus === 1 ? BLN[r.from.getMonth()] : fmtDateShort(r.from);
    return { lbl, inc: sumOf(l, 'pemasukan'), exp: sumOf(l, 'pengeluaran') };
  });
  while (rows.length > 1 && !rows[0].inc && !rows[0].exp) rows.shift(); // buang periode kosong sebelum data pertama
  if (!rows.some(x => x.inc || x.exp)) return emptyState('Belum ada data', 'Rekap bulanan muncul setelah ada transaksi.', false);
  return barChart({ id: 'Rekap bulanan', labels: rows.map(x => x.lbl), series: [{ values: rows.map(x => x.inc), color: '#14C8B8' }, { values: rows.map(x => x.exp), color: '#6A5CFF' }], line: S.settings.budgetBulanan, lineLabel: 'Budget' }) +
    `<div class="legend-inline"><span><i style="background:#14C8B8"></i>Pemasukan</span><span><i style="background:#6A5CFF"></i>Pengeluaran</span>${S.settings.budgetBulanan > 0 ? `<span><i class="dash"></i>Budget ${rpShort(S.settings.budgetBulanan)}</span>` : ''}</div>
    <table class="rekap-table"><thead><tr><th>Periode</th><th>Masuk</th><th>Keluar</th><th>Selisih</th></tr></thead><tbody>
    ${rows.slice().reverse().map(x => `<tr><td>${esc(x.lbl)}</td><td class="num inc">${rpShort(x.inc)}</td><td class="num exp">${rpShort(x.exp)}</td><td class="num ${x.inc - x.exp >= 0 ? 'inc' : 'exp'}">${x.inc - x.exp >= 0 ? '+' : '−'}${rpShort(Math.abs(x.inc - x.exp))}</td></tr>`).join('')}
    </tbody></table>`;
}

/* ---------- Pengaturan ---------- */
function renderSettings() {
  const s = S.settings, sheets = S.cfg && S.cfg.mode === 'sheets';
  const last = S.lastSync ? new Date(S.lastSync) : null;
  const hasSample = S.tx.some(t => t._sample);
  const row = (action, icon, title, sub, extra = '') => `<button class="set-row" data-action="${action}" ${extra}><span class="ic">${ico(icon, 'sm')}</span><span class="tx2"><b>${title}</b><span>${sub}</span></span><span class="chev">${ico('chev', 'sm')}</span></button>`;
  return `
  <div class="topbar"><div><h1>Pengaturan</h1><div class="sub" data-sync-pill></div></div></div>

  <div class="section-title" style="margin-top:8px"><h2>Koneksi data</h2></div>
  <div class="set-group">
    ${row('open-conn', 'link', sheets ? 'Google Sheets' : 'Mode lokal', sheets ? 'Terhubung · ' + esc(S.cfg.url.replace(/^https:\/\//, '').slice(0, 42)) + '…' : 'Data hanya tersimpan di HP ini. Ketuk untuk hubungkan Sheets.')}
    ${sheets ? row('sync', 'refresh', 'Sinkronkan sekarang', last ? `Terakhir ${last.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Belum pernah') : ''}
  </div>

  <div class="section-title"><h2>Budget</h2></div>
  <div class="set-group">
    ${row('open-budget', 'target', 'Budget bulanan & mingguan', `${rp(s.budgetBulanan)} / bulan · ${rp(s.budgetMingguan)} / minggu`)}
    ${row('open-budget', 'calendar', 'Siklus', `Bulan mulai tanggal ${s.awalSiklus} · minggu mulai Senin`)}
  </div>

  <div class="section-title"><h2>Kategori</h2></div>
  <div class="set-group">
    ${row('open-cats', 'tag', 'Kelola kategori', `${categoriesFor('pengeluaran').length} pengeluaran · ${categoriesFor('pemasukan').length} pemasukan${catsLocked('pengeluaran') || catsLocked('pemasukan') ? ' · mengikuti dropdown Sheets' : ''}`)}
  </div>

  <div class="section-title"><h2>Keamanan</h2></div>
  <div class="set-group">
    ${row('pin-change', 'lock', S.pin ? 'Ubah PIN' : 'Aktifkan PIN', S.pin ? 'PIN 6 digit aktif · kunci otomatis setelah 3 menit' : 'Kunci aplikasi dengan PIN 6 digit')}
    ${S.pin ? row('pin-off', 'x', 'Nonaktifkan PIN', 'Aplikasi terbuka tanpa PIN') : ''}
    ${S.pin ? row('lock-now', 'lock', 'Kunci sekarang', 'Tampilkan layar PIN') : ''}
  </div>

  <div class="section-title"><h2>Data</h2></div>
  <div class="set-group">
    ${row('export-csv', 'download', 'Ekspor CSV', `${S.tx.length} transaksi`)}
    ${hasSample ? row('clear-sample', 'trash', 'Hapus data contoh', 'Buang transaksi contoh dari mode lokal') : ''}
    ${row('reset-app', 'reset', 'Reset aplikasi di HP ini', sheets ? 'Data di Google Sheets tetap aman' : 'Semua data lokal akan terhapus')}
  </div>
  <p class="hint" style="text-align:center;margin-top:20px">Catatan Keuangan v${APP_VERSION}</p>`;
}

/* ---------------- Form tambah / edit ---------------- */
let F = null;
function openTxForm(tx) {
  const edit = !!tx;
  F = edit ? Object.assign({}, tx, { mode: 'edit', jenisTouched: true })
    : { mode: 'add', id: uuid(), jenis: 'pengeluaran', nominal: 0, kategori: null, tanggal: ymd(today()), keterangan: '', jenisTouched: false };
  openSheet(`
    <div class="sheet-head"><h3>${edit ? 'Ubah transaksi' : 'Tambah transaksi'}</h3><button class="icon-btn" data-action="close-sheet" aria-label="Tutup">${ico('x')}</button></div>
    <form class="sheet-body" id="tx-form" novalidate autocomplete="off">
      ${edit ? '' : `<div class="smart"><div class="inner">${ico('spark')}<input id="f-smart" placeholder='Ketik cepat: "Makan siang 25rb"' enterkeyhint="done" aria-label="Input cepat"></div></div>
      <div class="smart-preview" id="f-preview"><span class="hint" style="margin:0">Contoh: "Bensin 50000", "Gaji 5jt", "Kopi 18rb kemarin"</span></div>`}
      <div class="field"><div class="seg" id="f-jenis">
        <button type="button" data-j="pengeluaran">${ico('up', 'sm')} Pengeluaran</button>
        <button type="button" data-j="pemasukan">${ico('down', 'sm')} Pemasukan</button></div></div>
      <div class="field"><label for="f-nominal">Nominal</label>
        <div class="amount-wrap" id="f-amount-wrap"><span class="rp">Rp</span><input id="f-nominal" inputmode="numeric" placeholder="0" aria-describedby="f-nominal-err"></div>
        <div class="err-msg" id="f-nominal-err" hidden></div>
        <div class="quick">${[10000, 20000, 25000, 50000, 100000, 500000].map(v => `<button type="button" data-q="${v}">${rpShort(v)}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Kategori</span><div class="cat-grid" id="f-cats"></div><div class="err-msg" id="f-cat-err" hidden></div></div>
      <div class="field"><label for="f-tanggal">Tanggal</label><div class="date-row">
        <input class="input" type="date" id="f-tanggal" max="${ymd(addDays(today(), 366))}">
        <button type="button" class="btn ghost sm" data-d="0">Hari ini</button><button type="button" class="btn ghost sm" data-d="-1">Kemarin</button></div></div>
      <div class="field"><label for="f-ket">Catatan <span class="muted" style="font-weight:500">(opsional)</span></label><input class="input" id="f-ket" maxlength="200" placeholder="Contoh: makan siang bareng tim"></div>
    </form>
    <div class="sheet-foot">
      ${edit ? `<button class="btn danger" style="width:56px;flex-shrink:0" data-action="delete-tx" aria-label="Hapus">${ico('trash')}</button>` : ''}
      <button class="btn primary" id="f-save" data-action="save-tx"></button>
    </div>`, sh => {
    const smart = $('#f-smart', sh), nom = $('#f-nominal', sh), tgl = $('#f-tanggal', sh), ket = $('#f-ket', sh);
    nom.value = F.nominal ? nf.format(F.nominal) : '';
    tgl.value = F.tanggal; ket.value = F.keterangan || '';
    setJenis(F.jenis, false);

    if (smart) {
      setTimeout(() => smart.focus(), 280);
      smart.addEventListener('input', () => applySmart(smart.value));
      smart.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitTx(); } });
    } else {
      setTimeout(() => nom.focus(), 280);
    }
    nom.addEventListener('input', () => {
      const digits = nom.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 13);
      F.nominal = Number(digits) || 0;
      nom.value = digits ? nf.format(F.nominal) : '';
      clearErr('nominal');
    });
    nom.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitTx(); } });
    tgl.addEventListener('change', () => { F.tanggal = tgl.value || ymd(today()); });
    ket.addEventListener('input', () => { F.keterangan = ket.value; });
    ket.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitTx(); } });
    $('#f-jenis', sh).addEventListener('click', e => { const b = e.target.closest('[data-j]'); if (b) { F.jenisTouched = true; setJenis(b.dataset.j, true); } });
    $$('.quick button', sh).forEach(b => b.addEventListener('click', () => { F.nominal = Number(b.dataset.q); nom.value = nf.format(F.nominal); clearErr('nominal'); }));
    $$('[data-d]', sh).forEach(b => b.addEventListener('click', () => { F.tanggal = ymd(addDays(today(), Number(b.dataset.d))); tgl.value = F.tanggal; }));
    $('#tx-form', sh).addEventListener('submit', e => { e.preventDefault(); submitTx(); });
  });
}

function setJenis(j, resetCat) {
  F.jenis = j;
  $$('#f-jenis [data-j]').forEach(b => { b.classList.toggle('on', b.dataset.j === j); b.classList.toggle('exp-on', j === 'pengeluaran'); b.classList.toggle('inc-on', j === 'pemasukan'); });
  if (resetCat && !categoriesFor(j).includes(F.kategori)) F.kategori = null;
  renderCatGrid();
  const btn = $('#f-save');
  if (btn) {
    btn.classList.toggle('inc-btn', j === 'pemasukan');
    btn.innerHTML = ico('check') + (F.mode === 'edit' ? 'Simpan perubahan' : j === 'pemasukan' ? 'Simpan pemasukan' : 'Simpan pengeluaran');
  }
}
function renderCatGrid() {
  const el = $('#f-cats');
  if (!el) return;
  const list = categoriesFor(F.jenis).slice();
  if (F.kategori && !list.includes(F.kategori)) list.push(F.kategori); // kategori lama yang tidak ada di daftar
  el.innerHTML = list.map(c => `<button type="button" class="cat-btn ${F.kategori === c ? 'on' : ''}" data-c="${esc(c)}"><span class="e">${catEmoji(c, F.jenis)}</span>${esc(c)}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; F.kategori = b.dataset.c; renderCatGrid(); clearErr('cat'); };
}
function applySmart(text) {
  const p = parseSmart(text, F.jenisTouched ? F.jenis : null);
  const prev = $('#f-preview');
  if (!p) { prev.innerHTML = '<span class="hint" style="margin:0">Contoh: "Bensin 50000", "Gaji 5jt", "Kopi 18rb kemarin"</span>'; return; }
  if (p.jenis !== F.jenis) setJenis(p.jenis, true);
  if (p.nominal) { F.nominal = p.nominal; $('#f-nominal').value = nf.format(p.nominal); clearErr('nominal'); }
  if (p.kategori) { F.kategori = p.kategori; renderCatGrid(); clearErr('cat'); }
  if (p.tanggal) { F.tanggal = p.tanggal; $('#f-tanggal').value = p.tanggal; }
  F.keterangan = p.keterangan; $('#f-ket').value = p.keterangan;
  prev.innerHTML = [
    `<span class="tag ${p.jenis === 'pemasukan' ? 'inc' : 'exp'}" style="background:${p.jenis === 'pemasukan' ? 'var(--income-bg)' : 'var(--expense-bg)'}">${p.jenis === 'pemasukan' ? 'Pemasukan' : 'Pengeluaran'}</span>`,
    p.nominal ? `<span class="tag g num">${rp(p.nominal)}</span>` : '<span class="tag">nominal?</span>',
    p.kategori ? `<span class="tag g">${catEmoji(p.kategori, p.jenis)} ${esc(p.kategori)}</span>` : '<span class="tag">pilih kategori</span>',
    p.tanggal ? `<span class="tag">Kemarin</span>` : ''
  ].join('');
}
function showErr(k, msg) { const e = $('#f-' + k + '-err'); if (e) { e.textContent = msg; e.hidden = false; } if (k === 'nominal') $('#f-amount-wrap').classList.add('invalid'); }
function clearErr(k) { const e = $('#f-' + k + '-err'); if (e) e.hidden = true; if (k === 'nominal') { const w = $('#f-amount-wrap'); if (w) w.classList.remove('invalid'); } }

function submitTx() {
  if (!F) return;
  let ok = true;
  if (!F.nominal || F.nominal <= 0) { showErr('nominal', 'Nominal wajib diisi dan harus lebih dari 0.'); ok = false; }
  if (!F.kategori) { showErr('cat', 'Pilih kategori dulu.'); ok = false; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(F.tanggal || '')) { F.tanggal = ymd(today()); }
  if (!ok) {
    toast('Periksa lagi isian yang ditandai', 'err', 2200);
    if (navigator.vibrate) navigator.vibrate(60);
    return;
  }
  const tx = { id: F.id, jenis: F.jenis, tanggal: F.tanggal, kategori: F.kategori, keterangan: (F.keterangan || '').trim(), nominal: F.nominal };
  const isEdit = F.mode === 'edit';
  F = null;
  closeSheet();
  commitTx(tx, isEdit);
}

/* ---------------- Sheet lain ---------------- */
function openCustomPeriod(scope) {
  const cur = S.custom[scope] || { from: ymd(cycleRange().from), to: ymd(today()) };
  openSheet(`
    <div class="sheet-head"><h3>Periode custom</h3><button class="icon-btn" data-action="close-sheet" aria-label="Tutup">${ico('x')}</button></div>
    <div class="sheet-body">
      <div class="field"><label for="c-from">Dari tanggal</label><input class="input" type="date" id="c-from" value="${cur.from}"></div>
      <div class="field"><label for="c-to">Sampai tanggal</label><input class="input" type="date" id="c-to" value="${cur.to}"></div>
      <div class="err-msg" id="c-err" hidden></div>
    </div>
    <div class="sheet-foot"><button class="btn primary" id="c-apply">${ico('check')} Terapkan</button></div>`, sh => {
    $('#c-apply', sh).onclick = () => {
      const from = $('#c-from').value, to = $('#c-to').value;
      if (!from || !to || from > to) { const e = $('#c-err'); e.textContent = 'Tanggal awal harus sebelum atau sama dengan tanggal akhir.'; e.hidden = false; return; }
      S.custom[scope] = { from, to };
      if (scope === 'home') S.homePeriod = 'custom'; else S.statsPeriod = 'custom';
      closeSheet(); render(false);
    };
  });
}

function moneyInput(id, val) { return `<div class="amount-wrap" style="padding-bottom:6px"><span class="rp" style="font-size:18px">Rp</span><input id="${id}" inputmode="numeric" value="${val ? nf.format(val) : ''}" placeholder="0" style="font-size:24px"></div>`; }
function bindMoney(el) { el.addEventListener('input', () => { const d = el.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 13); el.value = d ? nf.format(Number(d)) : ''; }); }
const moneyVal = el => Number(el.value.replace(/\D/g, '')) || 0;

function openBudget() {
  const s = S.settings;
  openSheet(`
    <div class="sheet-head"><h3>Atur budget</h3><button class="icon-btn" data-action="close-sheet" aria-label="Tutup">${ico('x')}</button></div>
    <div class="sheet-body">
      <div class="field"><label for="b-m">Budget bulanan</label>${moneyInput('b-m', s.budgetBulanan)}</div>
      <div class="field"><label for="b-w">Budget mingguan</label>${moneyInput('b-w', s.budgetMingguan)}
        <div class="hint" id="b-hint"></div></div>
      <div class="field"><label for="b-s">Siklus bulanan mulai tanggal</label>
        <select class="input" id="b-s">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${s.awalSiklus === i + 1 ? 'selected' : ''}>Tanggal ${i + 1}${i === 0 ? ' (awal bulan kalender)' : ''}</option>`).join('')}</select>
        <div class="hint">Pilih tanggal gajian jika ingin siklus mengikuti gaji (mis. 25). Minggu selalu mulai Senin. Isi 0 untuk menonaktifkan budget.</div></div>
    </div>
    <div class="sheet-foot"><button class="btn primary" id="b-save">${ico('check')} Simpan budget</button></div>`, sh => {
    const m = $('#b-m', sh), w = $('#b-w', sh), hint = $('#b-hint', sh);
    bindMoney(m); bindMoney(w);
    const upd = () => { const mv = moneyVal(m), wv = moneyVal(w); hint.textContent = mv && wv ? `Info: ${rp(wv)} × ±4,3 minggu = ${rp(wv * 4.345)} (budget bulanan ${rp(mv)}).` : ''; };
    m.addEventListener('input', upd); w.addEventListener('input', upd); upd();
    $('#b-save', sh).onclick = async () => {
      await updateSettings({ budgetBulanan: moneyVal(m), budgetMingguan: moneyVal(w), awalSiklus: Number($('#b-s').value) });
      closeSheet(); toast('Budget disimpan', 'ok');
    };
  });
}

async function updateSettings(patch) {
  S.settings = normSettings(Object.assign({}, S.settings, patch, { kategori: Object.assign({}, S.settings.kategori, patch.kategori || {}) }));
  if (S.cfg.mode === 'sheets') {
    S.settingsDirty = true; saveSettingsLocal();
    try { const info = await apiCall('saveSettings', S.settings); S.settingsDirty = false; applyInfo(info); }
    catch (e) { toast('Disimpan di HP · akan dikirim ke server saat online', 'warn', 3200); }
  }
  saveSettingsLocal(); refreshView();
}

function openCats(jenis = 'pengeluaran') {
  const locked = catsLocked(jenis);
  const list = categoriesFor(jenis);
  openSheet(`
    <div class="sheet-head"><h3>Kategori</h3><button class="icon-btn" data-action="close-sheet" aria-label="Tutup">${ico('x')}</button></div>
    <div class="sheet-body">
      <div class="seg" id="k-jenis"><button type="button" data-j="pengeluaran" class="${jenis === 'pengeluaran' ? 'on exp-on' : ''}">Pengeluaran</button><button type="button" data-j="pemasukan" class="${jenis === 'pemasukan' ? 'on inc-on' : ''}">Pemasukan</button></div>
      ${locked ? `<div class="banner info" style="margin-top:14px">${ico('info')}<div><b>Mengikuti dropdown di Google Sheets</b>Kolom Kategori di sheet memakai dropdown, jadi daftar ini diambil dari sana agar data selalu valid. Ubah dropdown di Sheets, lalu ketuk Sinkronkan.</div></div>` : ''}
      <div class="kat-list" style="margin-top:14px">${list.map(c => `<span class="kat-item ${locked ? 'ro' : ''}">${catEmoji(c, jenis)} ${esc(c)}${locked ? '' : `<button data-del="${esc(c)}" aria-label="Hapus ${esc(c)}">${ico('x', 'xs')}</button>`}</span>`).join('')}</div>
      ${locked ? '' : `<div class="field"><label for="k-new">Tambah kategori</label><div class="date-row"><input class="input" id="k-new" maxlength="40" placeholder="Contoh: Kopi, Anak, Hewan peliharaan"><button class="btn primary sm" id="k-add">${ico('plus', 'sm')}</button></div><div class="err-msg" id="k-err" hidden></div></div>`}
    </div>`, sh => {
    $('#k-jenis', sh).onclick = e => { const b = e.target.closest('[data-j]'); if (b) openCats(b.dataset.j); };
    if (locked) return;
    const err = m => { const e = $('#k-err'); e.textContent = m; e.hidden = !m; };
    const save = async next => { await updateSettings({ kategori: { [jenis]: next } }); openCats(jenis); };
    $$('[data-del]', sh).forEach(b => b.onclick = async () => {
      if (list.length <= 1) return toast('Minimal harus ada 1 kategori', 'err');
      if (await confirmDialog({ title: 'Hapus kategori?', msg: `Kategori <b>${esc(b.dataset.del)}</b> dihapus dari pilihan. Transaksi lama dengan kategori ini tetap aman.`, ok: 'Hapus', danger: true })) save(list.filter(c => c !== b.dataset.del));
    });
    const add = () => {
      const v = $('#k-new').value.trim().replace(/\s+/g, ' ');
      if (!v) return err('Nama kategori tidak boleh kosong.');
      if (list.some(c => c.toLowerCase() === v.toLowerCase())) return err('Kategori sudah ada.');
      const next = list.filter(c => !/^lainnya$/i.test(c)).concat(v, list.filter(c => /^lainnya$/i.test(c)));
      save(next);
    };
    $('#k-add', sh).onclick = add;
    $('#k-new', sh).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  });
}

function connFields(cfg) {
  return `
    <div class="field"><label for="cn-url">URL Web App Apps Script</label><input class="input" id="cn-url" type="url" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg && cfg.url || '')}"></div>
    <div class="field"><label for="cn-token">Token rahasia</label><div class="date-row"><input class="input" id="cn-token" type="password" placeholder="Token dari log setupAwal()" value="${esc(cfg && cfg.token || '')}" autocomplete="off"><button type="button" class="btn ghost sm" id="cn-eye" aria-label="Lihat token">${ico('eye', 'sm')}</button></div>
      <div class="hint">Token tersimpan hanya di HP ini dan tidak pernah ditulis di kode.</div></div>
    <div class="err-msg" id="cn-err" hidden></div>`;
}
function readConn() {
  const url = $('#cn-url').value.trim(), token = $('#cn-token').value.trim();
  const err = m => { const e = $('#cn-err'); e.textContent = m; e.hidden = !m; return null; };
  if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) return err('URL harus berawalan https://script.google.com/macros/s/… dan diakhiri /exec');
  if (/\/dev(\?|$)/.test(url)) return err('Gunakan URL yang diakhiri /exec, bukan /dev.');
  if (token.length < 8) return err('Token terlalu pendek. Salin token dari log setupAwal().');
  err('');
  return { mode: 'sheets', url, token };
}
function bindEye(sh) { const b = $('#cn-eye', sh); if (b) b.onclick = () => { const t = $('#cn-token'); t.type = t.type === 'password' ? 'text' : 'password'; }; }

async function testAndConnect(cfg, btn) {
  const label = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Menghubungkan…';
  try {
    const d = await apiCall('ping', {}, cfg);
    return d;
  } catch (e) {
    const el = $('#cn-err');
    if (el) { el.textContent = e.message; el.hidden = false; }
    return null;
  } finally { btn.disabled = false; btn.innerHTML = label; }
}

/** Setelah koneksi berhasil: tawarkan kirim data lokal, lalu sinkron. */
async function activateSheets(cfg, info) {
  const localReal = S.tx.filter(t => !t._sample && !(S.cfg && S.cfg.mode === 'sheets'));
  S.tx = S.tx.filter(t => !t._sample);
  S.cfg = cfg; store.set(LS.cfg, cfg);
  applyInfo(info);
  S.syncError = null; S.lastSync = 0;
  if (localReal.length && await confirmDialog({ title: 'Kirim data dari HP?', msg: `Ada <b>${localReal.length} transaksi</b> yang dicatat di mode lokal. Kirim semuanya ke Google Sheets sebagai baris baru?`, ok: 'Kirim', cancel: 'Tidak' })) {
    localReal.forEach(t => { t._pending = true; enqueue({ type: 'add', tx: normTx(t) }); });
  } else {
    S.tx = [];
  }
  saveTx();
  await processQueue();
  await pull(true);
}

function openConn() {
  const sheets = S.cfg && S.cfg.mode === 'sheets';
  openSheet(`
    <div class="sheet-head"><h3>Koneksi Google Sheets</h3><button class="icon-btn" data-action="close-sheet" aria-label="Tutup">${ico('x')}</button></div>
    <div class="sheet-body">${connFields(S.cfg)}
      ${sheets ? `<button class="btn ghost" style="margin-top:18px" id="cn-local">Beralih ke mode lokal</button>` : ''}
    </div>
    <div class="sheet-foot"><button class="btn primary" id="cn-save">${ico('link')} Tes & simpan koneksi</button></div>`, sh => {
    bindEye(sh);
    $('#cn-save', sh).onclick = async e => {
      const cfg = readConn(); if (!cfg) return;
      const d = await testAndConnect(cfg, e.currentTarget); if (!d) return;
      closeSheet(); toast('Terhubung ke Google Sheets', 'ok');
      if (sheets) { S.cfg = cfg; store.set(LS.cfg, cfg); applyInfo(d.info); S.syncError = null; await processQueue(); await pull(true); }
      else await activateSheets(cfg, d.info);
    };
    const lb = $('#cn-local', sh);
    if (lb) lb.onclick = async () => {
      const pending = S.queue.length ? ` <b>${S.queue.length} perubahan belum terkirim akan hilang.</b>` : '';
      if (!await confirmDialog({ title: 'Beralih ke mode lokal?', msg: 'Data di Google Sheets tetap aman, tetapi aplikasi tidak lagi membaca/menulis ke sana dan daftar transaksi di HP dikosongkan.' + pending, ok: 'Beralih', danger: true })) return;
      S.cfg = { mode: 'local' }; store.set(LS.cfg, S.cfg);
      S.tx = []; S.queue = []; S.sheetCats = {}; S.lastSync = 0; S.syncError = null;
      saveTx(); saveQueue(); store.set(LS.sheetCats, {}); store.set(LS.lastSync, 0);
      closeSheet(); render(false); toast('Mode lokal aktif', 'ok');
    };
  });
}

function exportCsv() {
  const head = ['Tanggal', 'Jenis', 'Kategori', 'Keterangan', 'Nominal', 'ID'];
  const q = v => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = sortTx(S.tx).map(t => { const d = parseYmd(t.tanggal); return [`${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`, t.jenis, t.kategori, t.keterangan, t.nominal, t.id].map(q).join(','); });
  const blob = new Blob(['﻿' + [head.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `keuangan-${ymd(today())}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('File CSV diunduh', 'ok');
}

/* ---------------- Data contoh (mode lokal) ---------------- */
function sampleData() {
  const E = [
    ['Makanan & Minuman', 'Makan siang', 18000, 45000], ['Makanan & Minuman', 'Kopi', 15000, 35000], ['Makanan & Minuman', 'Sarapan', 10000, 25000],
    ['Transportasi', 'Bensin', 30000, 60000], ['Transportasi', 'Ojol ke kantor', 12000, 30000], ['Transportasi', 'Parkir', 2000, 5000],
    ['Belanja', 'Belanja mingguan', 150000, 350000], ['Belanja', 'Sabun & sampo', 30000, 70000],
    ['Hiburan', 'Nonton bioskop', 40000, 80000], ['Kesehatan', 'Vitamin', 30000, 90000], ['Sosial & Donasi', 'Sedekah Jumat', 10000, 50000]
  ];
  const out = [], t = today(), rnd = (a, b) => Math.round((a + Math.random() * (b - a)) / 1000) * 1000;
  for (let i = 75; i >= 0; i--) {
    const d = addDays(t, -i), s = ymd(d);
    const n = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) { const e = E[Math.floor(Math.random() * E.length)]; out.push({ kategori: e[0], keterangan: e[1], nominal: rnd(e[2], e[3]), jenis: 'pengeluaran', tanggal: s }); }
    if (d.getDate() === 25) out.push({ kategori: 'Gaji', keterangan: 'Gaji bulanan', nominal: 5000000, jenis: 'pemasukan', tanggal: s });
    if (d.getDate() === 1) out.push({ kategori: 'Tagihan & Utilitas', keterangan: 'Token listrik', nominal: 200000, jenis: 'pengeluaran', tanggal: s });
    if (d.getDate() === 12) out.push({ kategori: 'Freelance', keterangan: 'Proyek desain', nominal: 1250000, jenis: 'pemasukan', tanggal: s });
  }
  return out.map((x, i) => Object.assign(x, { id: uuid(), seq: i + 1, _sample: true }));
}

/* ---------------- PIN ---------------- */
async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(salt + ':' + pin);
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381; for (const b of data) h = ((h << 5) + h + b) >>> 0; // cadangan bila crypto.subtle tidak tersedia
  return 'd' + h.toString(16);
}

let pinFails = 0, pinLockUntil = 0;
function showPin(mode, onDone, opts = {}) {
  // mode: 'unlock' | 'create'
  const gate = $('#gate');
  $('#app').hidden = true; gate.hidden = false;
  let entry = '', first = null;
  const title = () => mode === 'unlock' ? 'Masukkan PIN' : first == null ? 'Buat PIN 6 digit' : 'Ulangi PIN';
  const sub = () => mode === 'unlock' ? 'Untuk membuka Catatan Keuangan' : first == null ? 'PIN melindungi aplikasi saat HP dipinjam orang lain.' : 'Masukkan PIN yang sama sekali lagi.';
  gate.className = 'gate pin-screen';
  gate.innerHTML = `
    <div class="brand" style="justify-content:center"><div class="logo">${ico('lock')}</div></div>
    <h1 id="pin-title" style="margin-top:18px">${title()}</h1><p class="lead" id="pin-sub" style="margin:0">${sub()}</p>
    <div class="pin-dots" id="pin-dots">${'<i></i>'.repeat(6)}</div>
    <div class="pin-msg" id="pin-msg"></div>
    <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join('')}
      <button class="plain" data-k="alt">${mode === 'unlock' ? 'Lupa?' : opts.skippable ? 'Lewati' : 'Batal'}</button><button data-k="0">0</button><button class="plain" data-k="del" aria-label="Hapus">${ico('del')}</button></div>`;
  const dots = $('#pin-dots'), msg = $('#pin-msg');
  const paint = () => $$('#pin-dots i').forEach((d, i) => d.classList.toggle('f', i < entry.length));
  const fail = m => { msg.textContent = m; dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake'); if (navigator.vibrate) navigator.vibrate(80); entry = ''; setTimeout(paint, 250); };
  const press = async k => {
    if (k === 'del') { entry = entry.slice(0, -1); paint(); return; }
    if (k === 'alt') {
      if (mode === 'unlock') return forgotPin();
      return onDone(false);
    }
    if (entry.length >= 6) return;
    if (mode === 'unlock' && Date.now() < pinLockUntil) { msg.textContent = `Terlalu banyak percobaan. Tunggu ${Math.ceil((pinLockUntil - Date.now()) / 1000)} detik.`; return; }
    entry += k; paint(); msg.textContent = '';
    if (entry.length < 6) return;
    if (mode === 'unlock') {
      const ok = (await hashPin(entry, S.pin.salt)) === S.pin.hash;
      if (ok) { pinFails = 0; onDone(true); }
      else { pinFails++; if (pinFails >= 5) { pinLockUntil = Date.now() + 30000; pinFails = 0; } fail('PIN salah, coba lagi.'); }
    } else if (first == null) {
      first = entry; entry = ''; setTimeout(() => { paint(); $('#pin-title').textContent = title(); $('#pin-sub').textContent = sub(); }, 150);
    } else if (entry === first) {
      const salt = uuid();
      S.pin = { salt, hash: await hashPin(entry, salt) }; store.set(LS.pin, S.pin);
      onDone(true);
    } else { first = null; fail('PIN tidak sama. Ulangi dari awal.'); setTimeout(() => { $('#pin-title').textContent = title(); $('#pin-sub').textContent = sub(); }, 300); }
  };
  gate.onclick = e => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); };
  document.onkeydown = e => { if (gate.hidden) return; if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); };
}

async function forgotPin() {
  const sheets = S.cfg && S.cfg.mode === 'sheets';
  const ok = await confirmDialog({
    title: 'Lupa PIN?',
    msg: sheets ? 'Aplikasi di HP ini akan di-reset. Data di Google Sheets <b>tetap aman</b>; kamu cukup memasukkan URL dan token lagi.' : 'Mode lokal: reset akan <b>menghapus semua data</b> yang tersimpan di HP ini. Lanjutkan?',
    ok: 'Reset', danger: true
  });
  if (ok) resetApp();
}
function resetApp() {
  Object.values(LS).forEach(k => store.del(k));
  location.reload();
}

/* ---------------- Onboarding ---------------- */
function showOnboarding() {
  const gate = $('#gate');
  $('#app').hidden = true; gate.hidden = false; gate.className = 'gate';
  let choice = 'sheets';
  gate.innerHTML = `
    <div class="brand"><div class="logo">${ico('wallet')}</div><div><b style="font-size:17px">Catatan Keuangan</b><div class="muted" style="font-size:13px">Cepat · Rapi · Terhubung ke Sheets</div></div></div>
    <h1>Catat keuangan dalam hitungan detik</h1>
    <p class="lead">Ketik "Makan siang 25rb", selesai. Data langsung masuk ke Google Sheets milikmu.</p>
    <button class="choice on" data-c="sheets"><span class="ic">📊</span><span><b>Hubungkan Google Sheets</b><span>Pakai spreadsheet Pemasukan & Pengeluaran yang sudah ada.</span></span></button>
    <div id="ob-sheets">${connFields(null)}<button class="btn primary" style="margin-top:18px" id="ob-connect">${ico('link')} Hubungkan</button></div>
    <button class="choice" data-c="local" style="margin-top:18px"><span class="ic">📱</span><span><b>Coba dulu tanpa Sheets</b><span>Data disimpan di HP ini. Bisa dihubungkan ke Sheets nanti.</span></span></button>
    <div id="ob-local" hidden>
      <label class="check"><input type="checkbox" id="ob-sample" checked> Isi dengan data contoh agar grafik langsung terlihat</label>
      <button class="btn primary" style="margin-top:16px" id="ob-start">Mulai</button>
    </div>
    <p class="hint" style="text-align:center;margin-top:auto;padding-top:24px">v${APP_VERSION}</p>`;
  bindEye(gate);
  $$('.choice', gate).forEach(b => b.onclick = () => {
    choice = b.dataset.c;
    $$('.choice', gate).forEach(x => x.classList.toggle('on', x === b));
    $('#ob-sheets').hidden = choice !== 'sheets'; $('#ob-local').hidden = choice !== 'local';
  });
  $('#ob-connect').onclick = async e => {
    const cfg = readConn(); if (!cfg) return;
    const d = await testAndConnect(cfg, e.currentTarget); if (!d) return;
    S.cfg = cfg; store.set(LS.cfg, cfg); applyInfo(d.info);
    toast('Terhubung ke Google Sheets', 'ok');
    afterOnboarding();
  };
  $('#ob-start').onclick = () => {
    S.cfg = { mode: 'local' }; store.set(LS.cfg, S.cfg);
    if ($('#ob-sample').checked) { S.tx = sampleData(); saveTx(); }
    afterOnboarding();
  };
}
function afterOnboarding() {
  showPin('create', () => startApp(), { skippable: true });
}

/* ---------------- Aksi global ---------------- */
const ACTIONS = {
  'open-add': () => openTxForm(null),
  'edit-tx': el => { const t = S.tx.find(x => x.id === el.dataset.id); if (t) openTxForm(t); },
  'save-tx': () => submitTx(),
  'delete-tx': async () => {
    if (!F) return;
    const t = F;
    if (await confirmDialog({ title: 'Hapus transaksi?', msg: `<b>${esc(t.keterangan || t.kategori)}</b> · ${rp(t.nominal)} pada ${fmtDate(t.tanggal)} akan dihapus${S.cfg.mode === 'sheets' ? ' dari Google Sheets' : ''}. Tindakan ini tidak bisa dibatalkan.`, ok: 'Hapus', danger: true })) {
      F = null; closeSheet(); removeTx(t.id);
    }
  },
  'close-sheet': () => { F = null; closeSheet(); },
  'sync': async () => {
    if (S.cfg.mode !== 'sheets') return toast('Mode lokal: hubungkan Google Sheets di menu Atur', 'warn');
    const r = await processQueue();
    await pull(false);
    if (r.ok && !S.syncError) toast('Data sudah terbaru', 'ok', 1600);
  },
  'period': el => {
    const scope = el.dataset.scope, k = el.dataset.k;
    if (k === 'custom') return openCustomPeriod(scope);
    if (scope === 'home') { S.homePeriod = k; store.set(LS.ui, { homePeriod: k }); } else S.statsPeriod = k;
    render(false);
  },
  'hist-jenis': el => { S.hist.jenis = el.dataset.k; $$('[data-action="hist-jenis"]').forEach(b => b.classList.toggle('on', b === el)); renderHistList(); },
  'hist-more': () => { S.hist.limit += 100; renderHistList(); },
  'open-budget': () => openBudget(),
  'open-cats': () => openCats('pengeluaran'),
  'open-conn': () => openConn(),
  'export-csv': () => exportCsv(),
  'clear-sample': async () => {
    if (await confirmDialog({ title: 'Hapus data contoh?', msg: 'Semua transaksi contoh akan dibuang. Transaksi yang kamu catat sendiri tetap ada.', ok: 'Hapus', danger: true })) {
      S.tx = S.tx.filter(t => !t._sample); saveTx(); render(false); toast('Data contoh dihapus', 'ok');
    }
  },
  'reset-app': async () => {
    const sheets = S.cfg.mode === 'sheets';
    if (await confirmDialog({ title: 'Reset aplikasi?', msg: sheets ? 'URL, token, PIN dan cache di HP ini dihapus. Data di Google Sheets <b>tidak tersentuh</b>.' : 'Semua transaksi di mode lokal akan <b>terhapus permanen</b>. Ekspor CSV dulu jika perlu.', ok: 'Reset', danger: true })) resetApp();
  },
  'pin-change': () => showPin('create', saved => { startApp(); if (saved) toast('PIN disimpan', 'ok'); }),
  'pin-off': async () => {
    if (await confirmDialog({ title: 'Nonaktifkan PIN?', msg: 'Siapa pun yang memegang HP ini bisa membuka aplikasi.', ok: 'Nonaktifkan', danger: true })) {
      S.pin = null; store.del(LS.pin); render(false); toast('PIN dinonaktifkan', 'ok');
    }
  },
  'lock-now': () => lockApp()
};

document.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { go(nav.dataset.nav); return; }
  const navGo = e.target.closest('[data-nav-go]');
  if (navGo) { go(navGo.dataset.navGo); return; }
  const a = e.target.closest('[data-action]');
  if (a && ACTIONS[a.dataset.action]) { e.preventDefault(); ACTIONS[a.dataset.action](a); }
});
$('#sheet-backdrop').addEventListener('click', () => { F = null; closeSheet(); });

/* ---------------- Siklus hidup aplikasi ---------------- */
let hiddenAt = 0;
function lockApp() {
  if (!S.pin) return;
  F = null; closeSheet();
  showPin('unlock', () => startApp());
}
function startApp() {
  document.onkeydown = null;
  $('#gate').hidden = true; $('#gate').innerHTML = '';
  $('#app').hidden = false;
  go(S.view || 'home');
  if (S.cfg.mode === 'sheets') processQueue().then(() => pull(true));
  if (/[?&]add=1/.test(location.search)) { // pintasan "Tambah transaksi" dari ikon aplikasi
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* abaikan */ }
    setTimeout(() => openTxForm(null), 150);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!S.cfg) return;
  if (S.pin && hiddenAt && Date.now() - hiddenAt > 180000 && !$('#app').hidden) { lockApp(); return; }
  if (!$('#app').hidden && S.cfg.mode === 'sheets' && Date.now() - S.lastSync > 60000) processQueue().then(() => pull(true));
});
window.addEventListener('online', () => { S.syncError = null; renderSyncPill(); if (S.cfg && S.cfg.mode === 'sheets' && !$('#app').hidden) processQueue().then(() => pull(true)); });
window.addEventListener('offline', () => renderSyncPill());

function boot() {
  loadState();
  if (!S.cfg) return showOnboarding();
  if (S.pin) return showPin('unlock', () => startApp());
  startApp();
}

// Service worker hanya aktif di HTTPS (GitHub Pages) atau localhost.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { /* abaikan */ }));
}

// Ekspor untuk pengujian otomatis (tidak dipakai aplikasi)
window.__KW = { parseSmart, extractAmount, budgetEval, S };

boot();
