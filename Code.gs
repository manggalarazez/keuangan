/**
 * ============================================================
 *  API CATATAN KEUANGAN — Google Apps Script (Backend)
 *  Versi 2.2 (rencana bulanan + aset + dana khusus + bot Telegram)
 * ============================================================
 *
 *  Cara pakai singkat (detail ada di panduan):
 *  1. Tempel seluruh kode ini di Ekstensi > Apps Script pada spreadsheet kamu.
 *  2. Jalankan fungsi  setupAwal  sekali (pilih di dropdown atas, klik Jalankan).
 *  3. Deploy > Deployment baru > Aplikasi web
 *       - Jalankan sebagai : Saya
 *       - Yang memiliki akses : Siapa saja
 *  4. Salin URL /exec dan TOKEN (lihat log) ke aplikasi di HP.
 *
 *  Fungsi bantu yang bisa dijalankan manual dari editor:
 *    setupAwal()   -> tambah kolom ID, isi ID data lama, buat token
 *    lihatToken()  -> tampilkan token yang aktif
 *    gantiToken()  -> buat token baru (token lama langsung tidak berlaku)
 *    cekStruktur() -> tampilkan kolom yang terdeteksi di kedua sheet
 *
 *  Prinsip keamanan data:
 *    - Hanya sel milik kolom Tanggal/Kategori/Keterangan/Nominal/ID yang ditulis.
 *    - Setiap baris dicari berdasarkan ID, bukan nomor baris, jadi aman walau sheet di-sort.
 *    - Semua penulisan memakai kunci (LockService) agar tidak saling menimpa.
 */

// ---------------- KONFIGURASI ----------------
const SHEET_NAMES = { pemasukan: 'Pemasukan', pengeluaran: 'Pengeluaran' };

// Nama header yang dikenali (huruf besar/kecil diabaikan).
const HEADER_ALIASES = {
  tanggal: ['tanggal', 'tgl', 'date', 'waktu'],
  kategori: ['kategori', 'category'],
  keterangan: ['keterangan', 'catatan', 'deskripsi', 'note', 'notes', 'uraian'],
  nominal: ['nominal', 'jumlah', 'amount', 'nilai'],
  id: ['id', 'id transaksi']
};
const REQUIRED_COLS = ['tanggal', 'kategori', 'nominal'];
const ID_HEADER = 'ID';

const PROP_TOKEN = 'API_TOKEN';
const PROP_SETTINGS = 'APP_SETTINGS';
const PLAN_PREFIX = 'PLAN_'; // rencana per bulan: PLAN_YYYY-MM-DD (tanggal mulai siklus)

// Sheet aset (dibuat otomatis bila belum ada)
const ASET_SHEET = 'Aset';
const MUTASI_SHEET = 'Mutasi Aset';
const ASET_HEADERS = ['ID', 'Nama', 'Jenis', 'Saldo Awal', 'Gram Awal', 'Tanggal Mulai', 'Harga per Gram', 'Aktif', 'Target'];
const MUTASI_HEADERS = ['ID', 'Tanggal', 'Aset ID', 'Aset', 'Jenis', 'Nominal', 'Gram', 'Catatan', 'Ref Transaksi'];
const ASET_JENIS = ['Kas utama', 'Bank', 'E-wallet', 'Tunai', 'Emas', 'Deposito', 'Dana khusus', 'Lainnya'];
// Arah transaksi yang tertaut ke aset:
//   pengeluaran: setor (kas -> aset) | bayar (dibayar langsung dari aset, kas tidak berubah)
//   pemasukan  : tarik (aset -> kas) | terima (uang masuk langsung ke aset, kas tidak berubah)
const ARAH = { setor: ['Setor', 1], bayar: ['Bayar', -1], tarik: ['Tarik', -1], terima: ['Terima', 1] };

const DEFAULT_SETTINGS = {
  budgetBulanan: 3000000,
  budgetMingguan: 750000,
  awalSiklus: 1, // tanggal mulai siklus bulanan (1-28)
  danaDarurat: 0, // pengeluaran wajib per bulan untuk menghitung dana darurat (0 = otomatis)
  kategori: {
    pemasukan: ['Gaji', 'Bonus', 'Freelance', 'Hasil Investasi', 'Ambil dari Tabungan', 'Lainnya'],
    pengeluaran: ['Makanan & Minuman', 'Transportasi', 'Belanja', 'Tagihan & Utilitas', 'Orang Tua',
      'Hiburan', 'Kesehatan', 'Pendidikan', 'Sosial & Donasi', 'Menabung', 'Lainnya']
  },
  budgetKategori: {} // { "Makanan & Minuman": { bulanan: 1500000, mingguan: true } }
};

// ---------------- ENDPOINT ----------------
function doGet() {
  return json_({ ok: true, message: 'API Catatan Keuangan aktif. Buka lewat aplikasi di HP.' });
}

function doPost(e) {
  // Pesan dari bot Telegram (webhook) dikenali dari parameter ?tg=<rahasia> di URL.
  if (e && e.parameter && e.parameter.tg) return telegramWebhook_(e);
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Format permintaan tidak valid.' });
  }

  const token = PropertiesService.getScriptProperties().getProperty(PROP_TOKEN);
  if (!token) {
    return json_({ ok: false, error: 'Server belum di-setup. Jalankan fungsi setupAwal() di editor Apps Script.' });
  }
  if (!req.token || String(req.token) !== token) {
    return json_({ ok: false, code: 'AUTH', error: 'Token salah. Periksa token di menu Atur.' });
  }

  try {
    return json_({ ok: true, data: route_(req.action, req.payload || {}) });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function route_(action, p) {
  switch (action) {
    case 'ping': return { serverTime: new Date().toISOString(), info: getInfo_() };
    case 'sync': return withLock_(syncAll_);
    case 'add': return withLock_(function () { return addTx_(p); });
    case 'update': return withLock_(function () { return updateTx_(p); });
    case 'delete': return withLock_(function () { return deleteTx_(p); });
    case 'saveSettings': return saveSettings_(p);
    case 'savePlan': return withLock_(function () { return savePlan_(p); });
    case 'saveAsset': return withLock_(function () { return saveAsset_(p); });
    case 'deleteAsset': return withLock_(function () { return deleteAsset_(p); });
    case 'addMutasi': return withLock_(function () { return addMutasi_(p); });
    case 'deleteMutasi': return withLock_(function () { return deleteMutasi_(p); });
    case 'telegram': return telegram_(p);
    default: throw new Error('Aksi tidak dikenal: ' + action);
  }
}

// ---------------- FUNGSI MANUAL (jalankan dari editor) ----------------
function setupAwal() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty(PROP_TOKEN);
  if (!token) {
    token = buatToken_();
    props.setProperty(PROP_TOKEN, token);
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const laporan = [];
  try {
    Object.keys(SHEET_NAMES).forEach(function (jenis) {
      const c = ctx_(jenis);
      const n = backfillIds_(c);
      laporan.push('Sheet "' + c.name + '": kolom ID di kolom ' + colLetter_(c.map.id + 1) +
        ', ' + n + ' baris lama diberi ID.');
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  const pesan = [
    '✅ SETUP SELESAI',
    laporan.join('\n'),
    '',
    '🔑 TOKEN KAMU (salin ke aplikasi, jangan dibagikan):',
    token,
    '',
    'Langkah berikutnya: Deploy > Deployment baru > Aplikasi web.'
  ].join('\n');
  Logger.log(pesan);
  return pesan;
}

/** Khusus spreadsheet BARU: membuat sheet Pemasukan & Pengeluaran beserta header. Aman dijalankan ulang. */
function siapkanSpreadsheetBaru() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Makassar');
  ['Pengeluaran', 'Pemasukan'].forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      const blank = ss.getSheets().filter(function (s) {
        return s.getLastRow() === 0 && !SHEET_NAMES_LIST_().includes(s.getName());
      })[0];
      sh = blank ? blank.setName(name) : ss.insertSheet(name);
    }
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, 4).setValues([['Tanggal', 'Kategori', 'Keterangan', 'Nominal']])
        .setFontWeight('bold').setBackground('#EEF1FA');
      sh.setFrozenRows(1);
      sh.getRange('A2:A').setNumberFormat('dd/MM/yyyy');
      sh.getRange('D2:D').setNumberFormat('"Rp" #,##0');
      sh.setColumnWidth(2, 160);
      sh.setColumnWidth(3, 260);
    }
  });
  SpreadsheetApp.flush();
  Logger.log('✅ Sheet Pemasukan & Pengeluaran siap. Lanjutkan dengan menjalankan setupAwal().');
}
function SHEET_NAMES_LIST_() { return [SHEET_NAMES.pemasukan, SHEET_NAMES.pengeluaran]; }

function lihatToken() {
  const t = PropertiesService.getScriptProperties().getProperty(PROP_TOKEN);
  Logger.log(t ? '🔑 Token aktif: ' + t : 'Token belum ada. Jalankan setupAwal() dulu.');
}

function gantiToken() {
  const t = buatToken_();
  PropertiesService.getScriptProperties().setProperty(PROP_TOKEN, t);
  Logger.log('🔑 Token BARU: ' + t + '\nToken lama sudah tidak berlaku. Masukkan token baru di menu Atur pada aplikasi.');
}

function cekStruktur() {
  Object.keys(SHEET_NAMES).forEach(function (jenis) {
    const c = ctx_(jenis, true);
    const out = Object.keys(HEADER_ALIASES).map(function (k) {
      return k + ' = ' + (c.map[k] == null ? '(tidak ada)' : colLetter_(c.map[k] + 1) + ' "' + c.headers[c.map[k]] + '"');
    });
    Logger.log('Sheet "' + c.name + '":\n  ' + out.join('\n  ') + '\n  baris data terakhir = ' + lastDataRow_(c));
  });
}

// ---------------- INTI: KONTEKS SHEET ----------------
/**
 * Membaca header baris 1 dan memetakan kolom.
 * @param {string} jenis 'pemasukan' | 'pengeluaran'
 * @param {boolean} noIdCreate jika true, tidak membuat kolom ID otomatis
 */
function ctx_(jenis, noIdCreate) {
  const name = SHEET_NAMES[jenis];
  if (!name) throw new Error('Jenis transaksi tidak valid: ' + jenis);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" tidak ditemukan. Pastikan nama sheet persis "' + name + '".');
  if (sh.getLastColumn() < 1) throw new Error('Sheet "' + name + '" belum punya header di baris 1.');

  let c = readHeaders_(ss, sh, name, jenis);
  REQUIRED_COLS.forEach(function (k) {
    if (c.map[k] == null) {
      throw new Error('Kolom "' + k + '" tidak ditemukan di sheet "' + name + '". Header terbaca: ' + c.headers.filter(String).join(', '));
    }
  });

  if (c.map.id == null && !noIdCreate) {
    ensureIdColumn_(c);
    c = readHeaders_(ss, sh, name, jenis);
  }
  return c;
}

function readHeaders_(ss, sh, name, jenis) {
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  const map = {};
  headers.forEach(function (h, i) {
    const key = h.toLowerCase();
    Object.keys(HEADER_ALIASES).forEach(function (k) {
      if (map[k] == null && HEADER_ALIASES[k].indexOf(key) !== -1) map[k] = i;
    });
  });
  // Ujung tabel = header berurutan pertama dari kolom A tanpa jeda kosong.
  let tableEnd = 0;
  while (tableEnd < headers.length && headers[tableEnd] !== '') tableEnd++;
  // Blok tabel = kolom A sampai kolom terpetakan paling kanan (biasanya ID).
  // Kolom di kanannya (mis. tabel ringkasan) tidak pernah disentuh.
  const mapped = Object.keys(map).map(function (k) { return map[k]; });
  const blockEnd = mapped.length ? Math.max.apply(null, mapped) + 1 : tableEnd;
  return {
    ss: ss, sh: sh, name: name, jenis: jenis, headers: headers, map: map,
    lastCol: lastCol, tableEnd: tableEnd, blockEnd: blockEnd,
    tz: ss.getSpreadsheetTimeZone()
  };
}

/** Menambahkan kolom ID tepat di kanan tabel (tidak menimpa isi lain). */
function ensureIdColumn_(c) {
  const sh = c.sh;
  const target = c.tableEnd + 1; // 1-based
  let needInsert = false;
  if (target <= sh.getMaxColumns()) {
    // Sisipkan kolom baru jika kolom target terisi, atau jika kolom sesudahnya terisi
    // (supaya jarak kosong pemisah dengan tabel lain di kanan tetap ada).
    const lastRow = Math.max(sh.getLastRow(), 1);
    const width = Math.min(2, sh.getMaxColumns() - target + 1);
    const vals = sh.getRange(1, target, lastRow, width).getValues();
    needInsert = vals.some(function (r) { return r.some(function (v) { return v !== '' && v !== null; }); });
  } else {
    sh.insertColumnsAfter(sh.getMaxColumns(), target - sh.getMaxColumns());
  }
  if (needInsert) sh.insertColumnAfter(c.tableEnd);
  if (c.tableEnd >= 1) {
    sh.getRange(1, c.tableEnd).copyTo(sh.getRange(1, target), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  }
  sh.getRange(1, target).setValue(ID_HEADER);
}

/** Baris data terakhir (1-based), dilihat dari kolom inti saja. 1 = belum ada data. */
function lastDataRow_(c) {
  const lastRow = c.sh.getLastRow();
  if (lastRow < 2) return 1;
  const cols = ['tanggal', 'nominal', 'kategori'].map(function (k) { return c.map[k]; });
  const vals = c.sh.getRange(2, 1, lastRow - 1, c.blockEnd).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (cols.some(function (ci) { return !isEmpty_(vals[i][ci]); })) return i + 2;
  }
  return 1;
}

/** Isi ID yang kosong pada baris yang berisi data. Hanya menulis kolom ID. */
function backfillIds_(c) {
  const last = lastDataRow_(c);
  if (last < 2) return 0;
  const n = last - 1;
  const block = c.sh.getRange(2, 1, n, c.blockEnd).getValues();
  const idRange = c.sh.getRange(2, c.map.id + 1, n, 1);
  const ids = idRange.getValues();
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = block[i];
    const hasData = !isEmpty_(r[c.map.tanggal]) || !isEmpty_(r[c.map.nominal]);
    if (hasData && isEmpty_(ids[i][0])) {
      ids[i][0] = Utilities.getUuid();
      count++;
    }
  }
  if (count) idRange.setValues(ids);
  return count;
}

// ---------------- BACA SEMUA DATA ----------------
function syncAll_() {
  const out = [];
  Object.keys(SHEET_NAMES).forEach(function (jenis) {
    const c = ctx_(jenis);
    backfillIds_(c); // baris yang ditambah manual di laptop otomatis dapat ID
    const last = lastDataRow_(c);
    if (last < 2) return;
    const vals = c.sh.getRange(2, 1, last - 1, c.blockEnd).getValues();
    vals.forEach(function (r, i) {
      const tx = rowToTx_(c, r, i + 2);
      if (tx) out.push(tx);
    });
  });
  SpreadsheetApp.flush();
  return { transaksi: out, info: getInfo_(), aset: listAset_() };
}

function rowToTx_(c, r, rowNum) {
  const tanggal = toYmd_(r[c.map.tanggal], c.tz);
  const nominal = toNumber_(r[c.map.nominal]);
  if (!tanggal && !nominal) return null;
  return {
    id: String(r[c.map.id] || ''),
    jenis: c.jenis,
    tanggal: tanggal,
    kategori: String(r[c.map.kategori] || '').trim() || 'Lainnya',
    keterangan: c.map.keterangan == null ? '' : String(r[c.map.keterangan] || '').trim(),
    nominal: nominal,
    seq: rowNum
  };
}

// ---------------- TAMBAH / UBAH / HAPUS ----------------
function addTx_(p) {
  const tx = validateTx_(p);
  // Idempoten: kalau ID sudah ada (misal dikirim ulang dari antrean offline), jangan duplikat.
  const found = findById_(tx.id);
  if (found) return rowToTx_(found.c, found.values, found.row);

  const c = ctx_(tx.jenis);
  const row = lastDataRow_(c) + 1;
  if (row > c.sh.getMaxRows()) c.sh.insertRowsAfter(c.sh.getMaxRows(), 1);

  // Salin format, validasi dropdown & rumus kolom lain dari baris di atasnya (jika ada).
  if (row >= 3) {
    const src = c.sh.getRange(row - 1, 1, 1, c.blockEnd);
    const dst = c.sh.getRange(row, 1, 1, c.blockEnd);
    src.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    src.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
    const formulas = src.getFormulasR1C1()[0];
    const mappedIdx = Object.keys(c.map).map(function (k) { return c.map[k]; });
    formulas.forEach(function (f, i) {
      if (f && mappedIdx.indexOf(i) === -1) c.sh.getRange(row, i + 1).setFormulaR1C1(f);
    });
  } else {
    c.sh.getRange(row, c.map.tanggal + 1).setNumberFormat('dd/MM/yyyy');
    c.sh.getRange(row, c.map.nominal + 1).setNumberFormat('"Rp" #,##0');
  }
  writeTxCells_(c, row, tx);
  c.sh.getRange(row, c.map.id + 1).setValue(tx.id);
  syncLinkedMutasi_(tx);
  SpreadsheetApp.flush();
  return Object.assign({}, tx, { seq: row });
}

function updateTx_(p) {
  if (!p.id) throw new Error('ID transaksi kosong.');
  const tx = validateTx_(p);
  const found = findById_(tx.id);
  if (!found) throw new Error('Transaksi tidak ditemukan di Sheets (mungkin sudah dihapus).');

  if (found.c.jenis !== tx.jenis) {
    // Pindah sheet: hapus dari sheet lama, tambah ke sheet baru dengan ID yang sama.
    removeRow_(found.c, found.row);
    return addTx_(tx);
  }
  writeTxCells_(found.c, found.row, tx);
  syncLinkedMutasi_(tx);
  SpreadsheetApp.flush();
  return Object.assign({}, tx, { seq: found.row });
}

function deleteTx_(p) {
  if (!p.id) throw new Error('ID transaksi kosong.');
  const found = findById_(String(p.id));
  if (!found) return { id: p.id, deleted: false, message: 'Sudah tidak ada.' };
  removeRow_(found.c, found.row);
  syncLinkedMutasi_({ id: String(p.id), aset: null });
  SpreadsheetApp.flush();
  return { id: p.id, deleted: true };
}

function writeTxCells_(c, row, tx) {
  const sh = c.sh;
  sh.getRange(row, c.map.tanggal + 1).setValue(Utilities.parseDate(tx.tanggal, c.tz, 'yyyy-MM-dd'));
  sh.getRange(row, c.map.kategori + 1).setValue(safeText_(tx.kategori));
  if (c.map.keterangan != null) sh.getRange(row, c.map.keterangan + 1).setValue(safeText_(tx.keterangan));
  sh.getRange(row, c.map.nominal + 1).setValue(tx.nominal);
}

/** Menghapus satu baris tabel. Jika ada isi lain di kanan tabel, hanya blok tabel yang digeser. */
function removeRow_(c, row) {
  if (c.blockEnd >= c.sh.getLastColumn()) {
    c.sh.deleteRow(row);
  } else {
    c.sh.getRange(row, 1, 1, c.blockEnd).deleteCells(SpreadsheetApp.Dimension.ROWS);
  }
}

function findById_(id) {
  if (!id) return null;
  const jenisList = Object.keys(SHEET_NAMES);
  for (let j = 0; j < jenisList.length; j++) {
    const c = ctx_(jenisList[j]);
    const last = lastDataRow_(c);
    if (last < 2) continue;
    const vals = c.sh.getRange(2, 1, last - 1, c.blockEnd).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][c.map.id]) === String(id)) return { c: c, row: i + 2, values: vals[i] };
    }
  }
  return null;
}

function validateTx_(p) {
  const jenis = String(p.jenis || '');
  if (!SHEET_NAMES[jenis]) throw new Error('Jenis harus pemasukan atau pengeluaran.');
  const nominal = Number(p.nominal);
  if (!isFinite(nominal) || nominal <= 0) throw new Error('Nominal harus angka lebih dari 0.');
  if (nominal > 1e13) throw new Error('Nominal terlalu besar.');
  const tanggal = String(p.tanggal || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) throw new Error('Format tanggal tidak valid.');
  const kategori = String(p.kategori || '').trim();
  if (!kategori) throw new Error('Kategori wajib diisi.');
  return {
    id: String(p.id || Utilities.getUuid()),
    jenis: jenis,
    tanggal: tanggal,
    kategori: kategori.slice(0, 60),
    keterangan: String(p.keterangan || '').trim().slice(0, 200),
    nominal: Math.round(nominal),
    // Opsional: transaksi ini menambah (pengeluaran/menabung) atau mengurangi (pemasukan/ambil) sebuah aset.
    aset: p.aset && p.aset.asetId ? { asetId: String(p.aset.asetId), gram: Math.abs(Number(p.aset.gram) || 0),
      arah: ARAH[p.aset.arah] ? p.aset.arah : (jenis === 'pengeluaran' ? 'setor' : 'tarik') } : null
  };
}

// ---------------- PENGATURAN ----------------
function getSettings_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_SETTINGS);
  let s = {};
  try { s = raw ? JSON.parse(raw) : {}; } catch (e) { s = {}; }
  const merged = Object.assign({}, DEFAULT_SETTINGS, s);
  merged.kategori = Object.assign({}, DEFAULT_SETTINGS.kategori, s.kategori || {});
  merged.budgetKategori = s.budgetKategori || {};
  return merged;
}

function saveSettings_(p) {
  const cur = getSettings_();
  const next = Object.assign({}, cur);
  if (p.budgetBulanan != null) next.budgetBulanan = Math.max(0, Math.round(Number(p.budgetBulanan) || 0));
  if (p.budgetMingguan != null) next.budgetMingguan = Math.max(0, Math.round(Number(p.budgetMingguan) || 0));
  if (p.danaDarurat != null) next.danaDarurat = Math.max(0, Math.round(Number(p.danaDarurat) || 0));
  if (p.awalSiklus != null) next.awalSiklus = Math.min(28, Math.max(1, Math.round(Number(p.awalSiklus) || 1)));
  if (p.kategori) {
    ['pemasukan', 'pengeluaran'].forEach(function (j) {
      if (Array.isArray(p.kategori[j])) {
        next.kategori[j] = p.kategori[j].map(function (k) { return String(k).trim().slice(0, 60); }).filter(String);
      }
    });
  }
  if (p.budgetKategori && typeof p.budgetKategori === 'object') {
    const bk = {};
    Object.keys(p.budgetKategori).slice(0, 60).forEach(function (k) {
      const v = p.budgetKategori[k] || {};
      const bulanan = Math.max(0, Math.round(Number(v.bulanan) || 0));
      const nama = String(k).trim().slice(0, 60);
      if (nama && bulanan > 0) bk[nama] = { bulanan: bulanan, mingguan: v.mingguan !== false };
    });
    next.budgetKategori = bk;
  }
  PropertiesService.getScriptProperties().setProperty(PROP_SETTINGS, JSON.stringify(next));
  return getInfo_();
}

function getInfo_() {
  const kategoriSheet = {};
  Object.keys(SHEET_NAMES).forEach(function (jenis) {
    try {
      const c = ctx_(jenis, true);
      kategoriSheet[jenis] = readDropdown_(c);
    } catch (e) {
      kategoriSheet[jenis] = null;
    }
  });
  return { settings: getSettings_(), kategoriSheet: kategoriSheet, sheetNames: SHEET_NAMES, rencana: getPlans_() };
}

/** Jika kolom Kategori memakai dropdown (validasi data), kembalikan daftar pilihannya. */
function readDropdown_(c) {
  const dv = c.sh.getRange(2, c.map.kategori + 1).getDataValidation();
  if (!dv) return null;
  const type = dv.getCriteriaType();
  const vals = dv.getCriteriaValues();
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    return (vals[0] || []).map(String).filter(String);
  }
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) {
    return vals[0].getValues().reduce(function (a, r) { return a.concat(r); }, []).map(String).filter(String);
  }
  return null;
}

// ---------------- RENCANA BULANAN ----------------
function savePlan_(p) {
  const periode = String(p.periode || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periode)) throw new Error('Periode rencana tidak valid.');
  const src = p.items && typeof p.items === 'object' ? p.items : {};
  const items = {};
  Object.keys(src).slice(0, 60).forEach(function (k) {
    const v = src[k] || {};
    const jatah = Math.max(0, Math.round(Number(v.jatah) || 0));
    const nama = String(k).trim().slice(0, 60);
    if (nama && jatah > 0) items[nama] = { jatah: jatah, mingguan: v.mingguan === true, lunas: v.lunas === true };
  });
  const props = PropertiesService.getScriptProperties();
  if (Object.keys(items).length) props.setProperty(PLAN_PREFIX + periode, JSON.stringify(items));
  else props.deleteProperty(PLAN_PREFIX + periode);
  return getInfo_();
}

function getPlans_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const out = {};
  Object.keys(all).filter(function (k) { return k.indexOf(PLAN_PREFIX) === 0; }).sort().slice(-36).forEach(function (k) {
    try { out[k.slice(PLAN_PREFIX.length)] = JSON.parse(all[k]); } catch (e) { /* abaikan */ }
  });
  return out;
}

// ---------------- ASET & MUTASI ----------------
function sheetFor_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#EEF1FA');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readTable_(sh, n) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, n).getValues()
    .map(function (r, i) { return { row: i + 2, v: r }; })
    .filter(function (x) { return !isEmpty_(x.v[0]); });
}

function writeRow_(sh, rowNum, values) {
  if (rowNum > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rowNum - sh.getMaxRows());
  sh.getRange(rowNum, 1, 1, values.length).setValues([values]);
}

function listAset_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const a = ss.getSheetByName(ASET_SHEET), m = ss.getSheetByName(MUTASI_SHEET);
  const aset = a ? readTable_(a, ASET_HEADERS.length).map(function (x) {
    const r = x.v;
    return { id: String(r[0]), nama: String(r[1]), jenis: String(r[2]), saldoAwal: Number(r[3]) || 0, gramAwal: Number(r[4]) || 0,
      mulai: toYmd_(r[5], tz), harga: Number(r[6]) || 0, aktif: !(r[7] === false || String(r[7]).toUpperCase() === 'FALSE'),
      target: Number(r[8]) || 0 };
  }) : [];
  const mutasi = m ? readTable_(m, MUTASI_HEADERS.length).map(function (x) {
    const r = x.v;
    return { id: String(r[0]), tanggal: toYmd_(r[1], tz), asetId: String(r[2]), jenis: String(r[4]), nominal: Number(r[5]) || 0,
      gram: Number(r[6]) || 0, catatan: String(r[7] || ''), ref: String(r[8] || '') };
  }) : [];
  return { aset: aset, mutasi: mutasi };
}

function saveAsset_(p) {
  const nama = String(p.nama || '').trim().slice(0, 60);
  if (!nama) throw new Error('Nama aset wajib diisi.');
  const jenis = ASET_JENIS.indexOf(p.jenis) >= 0 ? p.jenis : 'Lainnya';
  const mulai = String(p.mulai || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mulai)) throw new Error('Tanggal mulai aset tidak valid.');
  const id = String(p.id || Utilities.getUuid());
  const sh = sheetFor_(ASET_SHEET, ASET_HEADERS);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const values = [id, safeText_(nama), jenis, Math.round(Number(p.saldoAwal) || 0), Math.max(0, Number(p.gramAwal) || 0),
    Utilities.parseDate(mulai, tz, 'yyyy-MM-dd'), Math.max(0, Math.round(Number(p.harga) || 0)), p.aktif !== false,
    Math.max(0, Math.round(Number(p.target) || 0))];
  if (sh.getRange(1, 9).getValue() === '') sh.getRange(1, 9).setValue('Target'); // sheet dari versi 2.0
  const found = readTable_(sh, ASET_HEADERS.length).filter(function (x) { return String(x.v[0]) === id; })[0];
  writeRow_(sh, found ? found.row : Math.max(sh.getLastRow(), 1) + 1, values);
  if (!found) {
    sh.getRange(Math.max(sh.getLastRow(), 2), 6).setNumberFormat('dd/MM/yyyy');
    sh.getRange(Math.max(sh.getLastRow(), 2), 4).setNumberFormat('"Rp" #,##0');
  }
  SpreadsheetApp.flush();
  return listAset_();
}

/** Aset tidak dihapus (riwayatnya tetap ada), hanya ditandai tidak aktif. */
function deleteAsset_(p) {
  const sh = sheetFor_(ASET_SHEET, ASET_HEADERS);
  const found = readTable_(sh, ASET_HEADERS.length).filter(function (x) { return String(x.v[0]) === String(p.id); })[0];
  if (found) sh.getRange(found.row, 8).setValue(false);
  SpreadsheetApp.flush();
  return listAset_();
}

function addMutasi_(p) {
  const tanggal = String(p.tanggal || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) throw new Error('Tanggal mutasi tidak valid.');
  if (!p.asetId) throw new Error('Aset wajib dipilih.');
  const nominal = Math.round(Number(p.nominal) || 0), gram = Number(p.gram) || 0;
  if (!nominal && !gram) throw new Error('Nominal atau gram tidak boleh 0.');
  writeMutasi_({ id: String(p.id || Utilities.getUuid()), tanggal: tanggal, asetId: String(p.asetId), jenis: String(p.jenis || 'Penyesuaian').slice(0, 20),
    nominal: nominal, gram: gram, catatan: String(p.catatan || '').slice(0, 200), ref: '' });
  SpreadsheetApp.flush();
  return listAset_();
}

function deleteMutasi_(p) {
  const sh = sheetFor_(MUTASI_SHEET, MUTASI_HEADERS);
  const found = readTable_(sh, MUTASI_HEADERS.length).filter(function (x) { return String(x.v[0]) === String(p.id); })[0];
  if (found) sh.deleteRow(found.row);
  SpreadsheetApp.flush();
  return listAset_();
}

function writeMutasi_(m) {
  const sh = sheetFor_(MUTASI_SHEET, MUTASI_HEADERS);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const asetSh = sheetFor_(ASET_SHEET, ASET_HEADERS);
  const aset = readTable_(asetSh, ASET_HEADERS.length).filter(function (x) { return String(x.v[0]) === m.asetId; })[0];
  const values = [m.id, Utilities.parseDate(m.tanggal, tz, 'yyyy-MM-dd'), m.asetId, aset ? aset.v[1] : '(aset tidak ditemukan)', m.jenis,
    m.nominal, m.gram, safeText_(m.catatan), m.ref];
  const found = readTable_(sh, MUTASI_HEADERS.length).filter(function (x) { return String(x.v[0]) === m.id; })[0];
  const row = found ? found.row : Math.max(sh.getLastRow(), 1) + 1;
  writeRow_(sh, row, values);
  sh.getRange(row, 2).setNumberFormat('dd/MM/yyyy');
  sh.getRange(row, 6).setNumberFormat('"Rp" #,##0;-"Rp" #,##0');
}

/** Mutasi aset yang tertaut ke transaksi (Ref Transaksi = ID transaksi). */
function syncLinkedMutasi_(tx) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const exists = ss.getSheetByName(MUTASI_SHEET);
  if (!tx.aset && !exists) return;
  const sh = sheetFor_(MUTASI_SHEET, MUTASI_HEADERS);
  const linked = readTable_(sh, MUTASI_HEADERS.length).filter(function (x) { return String(x.v[8]) === String(tx.id); });
  if (!tx.aset) {
    linked.slice().reverse().forEach(function (x) { sh.deleteRow(x.row); });
    return;
  }
  // Setor/terima menambah aset; bayar/tarik menguranginya.
  const arah = ARAH[tx.aset.arah] || (tx.jenis === 'pengeluaran' ? ARAH.setor : ARAH.tarik);
  const sign = arah[1];
  linked.slice(1).reverse().forEach(function (x) { sh.deleteRow(x.row); });
  writeMutasi_({ id: linked.length ? String(linked[0].v[0]) : Utilities.getUuid(), tanggal: tx.tanggal, asetId: tx.aset.asetId,
    jenis: arah[0], nominal: sign * tx.nominal, gram: sign * (tx.aset.gram || 0),
    catatan: tx.keterangan || tx.kategori, ref: String(tx.id) });
}

// ---------------- UTILITAS ----------------
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Server sedang sibuk, coba lagi sebentar.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isEmpty_(v) { return v === '' || v === null || v === undefined; }

function toYmd_(v, tz) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // DD/MM/YYYY
  if (m) return m[3] + '-' + pad_(m[2]) + '-' + pad_(m[1]);
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // YYYY-MM-DD
  if (m) return m[1] + '-' + pad_(m[2]) + '-' + pad_(m[3]);
  return '';
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  let s = String(v || '').replace(/[^\d,.\-]/g, '');
  if (!s) return 0;
  s = s.split(',')[0].replace(/\./g, ''); // format Indonesia: titik = ribuan, koma = desimal
  const n = Number(s);
  return isFinite(n) ? n : 0;
}

/** Cegah teks dianggap rumus (mis. diawali "=" atau "+"). */
function safeText_(s) {
  s = String(s || '');
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function pad_(n) { return ('0' + n).slice(-2); }

function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function buatToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
}

// =====================================================================
//  BOT TELEGRAM (v2.2)
//  Chat ke bot pribadi -> tercatat di sheet yang sama dengan aplikasi.
//  Token bot hanya disimpan di Script Properties, tidak pernah di aplikasi/kode.
//  Bot hanya melayani SATU akun Telegram (pemilik) yang dipasangkan lewat link dari aplikasi.
// =====================================================================
const TG_P = { token: 'TG_TOKEN', secret: 'TG_SECRET', bot: 'TG_BOT', owner: 'TG_OWNER', ownerName: 'TG_OWNER_NAME',
  pair: 'TG_PAIR', lastUpd: 'TG_LAST_UPDATE', lastTx: 'TG_LAST_TX' };
const TG_SAVING_RE = /tabung|menabung|investasi|dana darurat|emas/i;
const TG_WITHDRAW_RE = /ambil|tarik|cair|jual emas|dari tabungan/i;
const TG_BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const TG_BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** Jalankan SEKALI dari editor agar Google meminta izin "terhubung ke layanan eksternal" (dipakai untuk Telegram). */
function izinkanTelegram() {
  UrlFetchApp.fetch('https://api.telegram.org', { muteHttpExceptions: true });
  Logger.log('Izin OK. Sekarang hubungkan bot dari aplikasi: Pengaturan -> Bot Telegram.');
}

/** Aksi dari aplikasi (sudah lolos cek token API). */
function telegram_(p) {
  const props = PropertiesService.getScriptProperties();
  const op = String(p.op || 'status');
  if (op === 'status') return tgStatus_();
  if (op === 'connect') {
    const botToken = String(p.botToken || '').trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) throw new Error('Token bot tidak valid. Salin token dari @BotFather (bentuknya 123456789:AAH…).');
    const url = String(p.url || '').trim();
    if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('URL Web App harus berbentuk https://script.google.com/macros/s/…/exec');
    const me = tgApi_(botToken, 'getMe', {});
    if (!me.ok) throw new Error('Token bot ditolak Telegram: ' + (me.description || 'tidak dikenal'));
    const secret = Utilities.getUuid().replace(/-/g, '');
    const wh = tgApi_(botToken, 'setWebhook', { url: url + '?tg=' + secret, allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true, max_connections: 5 });
    if (!wh.ok) throw new Error('Gagal memasang webhook: ' + (wh.description || 'tidak dikenal'));
    tgApi_(botToken, 'setMyCommands', { commands: [
      { command: 'rekap', description: 'Rekap bulan ini' }, { command: 'hariini', description: 'Catatan hari ini' },
      { command: 'batal', description: 'Hapus catatan terakhir' }, { command: 'bantuan', description: 'Cara pakai' }] });
    props.setProperty(TG_P.token, botToken);
    props.setProperty(TG_P.secret, secret);
    props.setProperty(TG_P.bot, String(me.result.username || ''));
    props.setProperty(TG_P.lastUpd, '0');
    props.deleteProperty(TG_P.owner); props.deleteProperty(TG_P.ownerName); props.deleteProperty(TG_P.lastTx);
    tgNewPair_();
    return tgStatus_();
  }
  if (op === 'pair') {
    if (!props.getProperty(TG_P.token)) throw new Error('Bot belum dihubungkan.');
    props.deleteProperty(TG_P.owner); props.deleteProperty(TG_P.ownerName);
    tgNewPair_();
    return tgStatus_();
  }
  if (op === 'disconnect') {
    const t = props.getProperty(TG_P.token);
    if (t) { try { tgApi_(t, 'deleteWebhook', { drop_pending_updates: true }); } catch (e) { /* abaikan */ } }
    Object.keys(TG_P).forEach(function (k) { props.deleteProperty(TG_P[k]); });
    return tgStatus_();
  }
  throw new Error('Operasi Telegram tidak dikenal: ' + op);
}

function tgNewPair_() {
  const kode = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  PropertiesService.getScriptProperties().setProperty(TG_P.pair, JSON.stringify({ kode: kode, exp: Date.now() + 30 * 60 * 1000 }));
  return kode;
}

function tgStatus_() {
  const pr = PropertiesService.getScriptProperties().getProperties();
  const token = pr[TG_P.token];
  if (!token) return { connected: false };
  let pair = null;
  try { pair = JSON.parse(pr[TG_P.pair] || 'null'); } catch (e) { pair = null; }
  if (pair && pair.exp < Date.now()) pair = null;
  let webhook = null;
  try {
    const r = tgApi_(token, 'getWebhookInfo', {});
    if (r.ok) webhook = { aktif: !!r.result.url, pending: r.result.pending_update_count || 0,
      lastError: r.result.last_error_message || '', lastErrorDate: (r.result.last_error_date || 0) * 1000 };
  } catch (e) { webhook = null; }
  const bot = pr[TG_P.bot] || '';
  const owner = !!pr[TG_P.owner];
  return { connected: true, bot: bot, owner: owner, ownerName: pr[TG_P.ownerName] || '',
    link: owner || !pair ? 'https://t.me/' + bot : 'https://t.me/' + bot + '?start=' + pair.kode,
    kode: owner || !pair ? null : pair.kode, kodeExp: owner || !pair ? null : pair.exp, webhook: webhook };
}

function tgApi_(token, method, payload) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true });
  try { return JSON.parse(res.getContentText()); } catch (e) { return { ok: false, description: 'HTTP ' + res.getResponseCode() }; }
}

function tgSend_(token, chatId, text, keyboard) {
  const body = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return tgApi_(token, 'sendMessage', body);
}

/** Webhook. Selalu dibalas HtmlService (HTTP 200 langsung): ContentService di-redirect 302 dan membuat Telegram mengirim ulang. */
function telegramWebhook_(e) {
  const ok = HtmlService.createHtmlOutput('ok');
  try {
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty(TG_P.secret);
    if (!secret || String(e.parameter.tg) !== secret) return ok;
    const upd = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (!tgFresh_(upd.update_id)) return ok;
    const token = props.getProperty(TG_P.token);
    if (!token) return ok;
    if (upd.callback_query) tgCallback_(token, upd.callback_query);
    else if (upd.message) tgMessage_(token, upd.message);
  } catch (err) {
    console.error('telegram: ' + ((err && err.stack) || err));
  }
  return ok;
}

/** Cegah pesan yang sama diproses dua kali (Telegram mengirim ulang bila menganggap gagal). */
function tgFresh_(id) {
  if (!id) return true;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return true;
  try {
    const p = PropertiesService.getScriptProperties();
    if (Number(id) <= Number(p.getProperty(TG_P.lastUpd) || 0)) return false;
    p.setProperty(TG_P.lastUpd, String(id));
    return true;
  } finally { lock.releaseLock(); }
}

function tgMessage_(token, msg) {
  if (!msg.chat || msg.chat.type !== 'private') return;
  const props = PropertiesService.getScriptProperties();
  const chatId = String(msg.chat.id);
  const owner = props.getProperty(TG_P.owner);
  const text = String(msg.text || '').trim();
  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/i);
  if (start) {
    if (owner === chatId) return tgSend_(token, chatId, tgHelp_());
    let pair = null;
    try { pair = JSON.parse(props.getProperty(TG_P.pair) || 'null'); } catch (e) { pair = null; }
    if (!owner && pair && start[1] && start[1] === pair.kode && Date.now() < pair.exp) {
      props.setProperty(TG_P.owner, chatId);
      props.setProperty(TG_P.ownerName, String((msg.from && (msg.from.first_name || msg.from.username)) || '').slice(0, 40));
      props.deleteProperty(TG_P.pair);
      return tgSend_(token, chatId, '✅ <b>Bot terhubung ke Catatan Keuangan kamu.</b>\nHanya akun Telegram ini yang bisa mencatat.\n\n' + tgHelp_());
    }
    return tgSend_(token, chatId, '🔒 Bot ini privat. Hubungkan dari aplikasi: ⚙️ Pengaturan → Bot Telegram.');
  }
  if (owner !== chatId) return; // akun lain diabaikan
  if (!text) return tgSend_(token, chatId, 'Kirim dalam bentuk teks ya, contoh: <i>makan siang 25rb</i>');
  const cmd = text.toLowerCase().replace(/^\//, '').replace(/@\w+$/, '').replace(/\s+/g, ' ').trim();
  if (/^(start|help|bantuan|menu|\?)$/.test(cmd)) return tgSend_(token, chatId, tgHelp_());
  if (/^(rekap|ringkasan|laporan|rekap bulan ini)$/.test(cmd)) return tgSend_(token, chatId, tgRekap_());
  if (/^(hari ?ini|today)$/.test(cmd)) return tgSend_(token, chatId, tgToday_());
  if (/^(batal|undo|hapus|hapus terakhir)$/.test(cmd)) return tgUndo_(token, chatId);
  tgRecord_(token, chatId, text);
}

function tgHelp_() {
  return '<b>Cara pakai</b>\n' +
    '• Ketik saja: <i>makan siang 25rb</i>, <i>bensin 50.000</i>, <i>+gaji 22jt</i>\n' +
    '• Banyak sekaligus: satu baris satu transaksi\n' +
    '• Tambah <i>kemarin</i> untuk tanggal kemarin\n' +
    '• <i>tiket pesawat 1,5jt dari traveling</i> → dibayar dari dana Traveling\n' +
    '• <i>nabung 2jt ke tabungan bank</i> → masuk ke aset\n\n' +
    '<b>Perintah</b>: /rekap · /hariini · /batal · /bantuan';
}

// ---------- konteks: kategori, aset, tanggal ----------
function tgCtx_() {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const settings = getSettings_();
  const cats = {};
  ['pemasukan', 'pengeluaran'].forEach(function (j) {
    let list = null;
    try { list = readDropdown_(ctx_(j, true)); } catch (e) { list = null; }
    cats[j] = list && list.length ? list : (settings.kategori[j] || []);
  });
  const a = listAset_();
  return { tz: tz, settings: settings, cats: cats, assets: a.aset.filter(function (x) { return x.aktif; }), mutasi: a.mutasi,
    today: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd') };
}

function tgAddDays_(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

function tgCycle_(todayYmd, s) {
  s = Math.min(28, Math.max(1, Number(s) || 1));
  const y = +todayYmd.slice(0, 4), m = +todayYmd.slice(5, 7), d = +todayYmd.slice(8, 10);
  const from = d >= s ? new Date(Date.UTC(y, m - 1, s)) : new Date(Date.UTC(y, m - 2, s));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, s));
  const to = new Date(next.getTime() - 864e5);
  const label = s === 1 ? TG_BULAN[from.getUTCMonth()] + ' ' + from.getUTCFullYear()
    : from.getUTCDate() + ' ' + TG_BLN[from.getUTCMonth()] + ' – ' + to.getUTCDate() + ' ' + TG_BLN[to.getUTCMonth()];
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), label: label };
}

function tgAllTx_() {
  const out = [];
  Object.keys(SHEET_NAMES).forEach(function (jenis) {
    const c = ctx_(jenis, true);
    const last = lastDataRow_(c);
    if (last < 2) return;
    c.sh.getRange(2, 1, last - 1, c.blockEnd).getValues().forEach(function (r, i) {
      const tx = rowToTx_(c, r, i + 2);
      if (tx && tx.nominal) out.push(tx);
    });
  });
  return out;
}

// ---------- pembaca teks (sama dengan input cepat di aplikasi) ----------
const TG_RULES = [
  { j: 'pengeluaran', cat: /makan|minum|kuliner|food|jajan/i, kw: 'makan|minum|sarapan|nasi|kopi|ngopi|teh|jus|bakso|mie|mi ayam|soto|sate|geprek|padang|warteg|warung|resto|restoran|cafe|kafe|snack|jajan|cemilan|camilan|gofood|grabfood|shopeefood|martabak|roti|pizza|burger|kfc|mcd|mcdonald|starbucks|boba|susu|gorengan|seblak|pecel|coto|konro|pallubasa|es krim|es teh|air mineral|katering|catering|lauk|buah|kue|dimsum|ayam|ikan|bebek' },
  { j: 'pengeluaran', cat: /transport|bensin|kendaraan/i, kw: 'bensin|bbm|pertalite|pertamax|solar|isi minyak|ojek|ojol|gojek|goride|gocar|grab|grabbike|grabcar|maxim|taksi|taxi|parkir|tol|etoll|e-toll|bus|busway|transjakarta|kereta|krl|mrt|lrt|pesawat|tiket pesawat|angkot|damri|kapal|ferry|pelni|servis motor|servis mobil|bengkel|ganti oli|oli|cuci motor|cuci mobil|ban|travel' },
  { j: 'pengeluaran', cat: /belanja|shopping/i, kw: 'belanja|beli|baju|celana|sepatu|sandal|tas|shopee|tokopedia|tokped|lazada|tiktok shop|blibli|indomaret|alfamart|alfamidi|supermarket|minimarket|hypermart|pasar|sayur|beras|minyak goreng|gula|telur|galon|elpiji|lpg|gas elpiji|sabun|sampo|shampo|odol|pasta gigi|deterjen|tisu|skincare|kosmetik|perabot|elektronik|gadget|aksesoris|kebutuhan rumah' },
  { j: 'pengeluaran', cat: /tagihan|utilitas|listrik/i, kw: 'listrik|pln|token listrik|token|pdam|tagihan|pulsa|kuota|paket data|internet|wifi|indihome|biznet|first media|bpjs|cicilan|angsuran|kredit|kos|kost|sewa|kontrakan|asuransi|pajak|pbb|iuran|langganan|ipl|biaya admin|admin bank' },
  { j: 'pengeluaran', cat: /hiburan|rekreasi/i, kw: 'nonton|bioskop|cinema|xxi|cgv|netflix|spotify|youtube premium|disney|vidio|game|top up|voucher game|steam|liburan|wisata|rekreasi|karaoke|konser|hotel|staycation|jalan-jalan|jalan jalan|nongkrong|hobi' },
  { j: 'pengeluaran', cat: /kesehatan|medis/i, kw: 'obat|dokter|apotek|apotik|klinik|rumah sakit|puskesmas|vitamin|suplemen|periksa|cek darah|lab|gigi|kacamata|masker|terapi|pijat|gym|fitness' },
  { j: 'pengeluaran', cat: /pendidikan|edukasi|sekolah/i, kw: 'buku|kursus|kuliah|ukt|spp|sekolah|les|seminar|webinar|pelatihan|sertifikasi|ujian|alat tulis|fotokopi|print|udemy|coursera' },
  { j: 'pengeluaran', cat: /tabung|menabung|investasi|dana darurat/i, kw: 'nabung|menabung|tabungan|investasi|reksadana|deposito|dana darurat|beli emas|emas antam' },
  { j: 'pengeluaran', cat: /orang ?tua|ortu|keluarga/i, kw: 'ortu|orang tua|orangtua|kirim mama|kirim ibu|kirim bapak|kirim ayah|kirim papa|transfer ortu|transfer mama|transfer ibu|uang bulanan ortu|jatah ortu' },
  { j: 'pengeluaran', cat: /sosial|donasi|amal|zakat/i, kw: 'sedekah|zakat|infak|infaq|donasi|kondangan|sumbangan|arisan|amplop|kado|traktir|kolekte|perpuluhan|persembahan' },
  { j: 'pemasukan', cat: /gaji/i, kw: 'gaji|gajian|salary|upah' },
  { j: 'pemasukan', cat: /bonus|thr/i, kw: 'bonus|thr|insentif|tunjangan|komisi' },
  { j: 'pemasukan', cat: /freelance|proyek|project/i, kw: 'freelance|proyek|project|fee|honor|honorarium|jasa|klien|client' },
  { j: 'pemasukan', cat: /investasi|dividen/i, kw: 'dividen|bunga deposito|bunga|imbal hasil|kupon|reksadana|saham|profit|cuan' },
  { j: 'pemasukan', cat: /ambil|tarik|cair|tabung/i, kw: 'ambil tabungan|ambil dari tabungan|tarik tabungan|pencairan|cairkan|jual emas|pakai tabungan|pakai dana darurat|ambil dana darurat' },
  { j: 'pemasukan', cat: /lain/i, kw: 'jual|penjualan|terima|diterima|dapat|dapet|cashback|refund|transfer masuk|uang masuk|pemasukan|kiriman' }
];
const TG_LOW_WEIGHT = { beli: 2, token: 3, tol: 4 };
const tgEsc_ = function (w) { return w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); };
TG_RULES.forEach(function (r) {
  r.words = r.kw.split('|').map(function (w) {
    const tail = w.length < 4 ? '(?![a-z0-9])' : '';
    return { re: new RegExp('(?:^|[^a-z0-9])' + tgEsc_(w) + tail, 'i'), weight: TG_LOW_WEIGHT[w] || w.length };
  });
});
function tgHasWord_(text, w) { return new RegExp('(?:^|[^a-z0-9])' + tgEsc_(w), 'i').test(text); }

function tgAmount_(text) {
  const re = /(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)(?:\s*(ribu|rbu|rb|k|juta|jt))?(?![a-z0-9])/gi;
  let best = null, m;
  while ((m = re.exec(text))) {
    const num = m[1], suf = (m[2] || '').toLowerCase();
    let v = /^\d{1,3}(?:[.,]\d{3})+$/.test(num) ? Number(num.replace(/[.,]/g, '')) : Number(num.replace(',', '.'));
    if (suf === 'rb' || suf === 'ribu' || suf === 'rbu' || suf === 'k') v *= 1e3;
    if (suf === 'jt' || suf === 'juta') v *= 1e6;
    v = Math.round(v);
    if (isFinite(v) && v > 0 && (!best || v > best.value)) best = { value: v, text: m[0], index: m.index };
  }
  return best;
}

/** Pecah "bensin 50rb, kopi 25rb" / beberapa baris menjadi beberapa transaksi (hanya bila tiap bagian punya nominal). */
function tgSplit_(text) {
  const out = [];
  text.split(/\n+/).map(function (s) { return s.trim(); }).filter(String).forEach(function (line) {
    const pieces = line.split(/\s*;\s*|,\s+(?=[^\d\s])|\s+\+\s+|\s+(?:dan|sama|&)\s+/i).map(function (s) { return s.trim(); }).filter(String);
    if (pieces.length > 1 && pieces.every(function (p) { return tgAmount_(p.replace(/(\d+(?:[.,]\d+)?)\s*(?:gram|gr|g)(?![a-z0-9])/i, ' ')); })) out.push.apply(out, pieces);
    else out.push(line);
  });
  return out.slice(0, 20);
}

function tgParse_(raw, ctx) {
  let forced = null;
  raw = String(raw || '').trim();
  if (raw.charAt(0) === '+') forced = 'pemasukan';
  const lower = raw.toLowerCase();
  const gm = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:gram|gr|g)(?![a-z0-9])/i);
  const gram = gm ? Number(gm[1].replace(',', '.')) : 0;
  const rawNoGram = gm ? raw.replace(gm[0], ' ') : raw;
  const amt = tgAmount_(rawNoGram);
  let tanggal = null;
  if (/(?:^|\s)(kemarin lusa|lusa kemarin)(?:\s|$)/i.test(lower)) tanggal = tgAddDays_(ctx.today, -2);
  else if (/(?:^|\s)kemarin(?:\s|$)/i.test(lower)) tanggal = tgAddDays_(ctx.today, -1);

  let best = null;
  TG_RULES.forEach(function (r) {
    if (forced && r.j !== forced) return;
    let score = 0;
    r.words.forEach(function (w) { if (w.re.test(lower)) score += w.weight; });
    if (score > 0 && (!best || score > best.score)) best = { rule: r, j: r.j, score: score };
  });
  (forced ? [forced] : ['pengeluaran', 'pemasukan']).forEach(function (j) {
    (ctx.cats[j] || []).forEach(function (cat) {
      const full = cat.toLowerCase();
      const words = full.split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 4; });
      const score = tgHasWord_(lower, full) ? 20 : (words.some(function (w) { return tgHasWord_(lower, w); }) ? 12 : 0);
      if (score && (!best || score > best.score)) best = { direct: cat, j: j, score: score };
    });
  });
  const jenis = forced || (best ? best.j : 'pengeluaran');
  const list = ctx.cats[jenis] || [];
  let kategori = null;
  if (best) kategori = best.direct || list.filter(function (c) { return best.rule.cat.test(c); })[0] || null;
  const guessed = !!kategori;
  if (!kategori) kategori = list.filter(function (c) { return /lain/i.test(c); })[0] || 'Lainnya';

  let ket = rawNoGram;
  if (amt) ket = ket.slice(0, amt.index) + ' ' + ket.slice(amt.index + amt.text.length);
  ket = ket.replace(/^\s*\+/, '').replace(/(?:^|\s)(kemarin lusa|lusa kemarin|kemarin|hari ini|tadi|barusan)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(abis|habis|baru|udah|sudah)\s+/i, '')
    .replace(/\s+(harganya|harga|seharga|sebesar|totalnya|total|senilai|bayar|rp\.?)$/i, '')
    .replace(/^[\s,.\-:]+|[\s,.\-:]+$/g, '').trim();
  if (ket) ket = ket.charAt(0).toUpperCase() + ket.slice(1);
  const p = { nominal: amt ? amt.value : 0, jenis: jenis, kategori: kategori, guessed: guessed, keterangan: ket.slice(0, 200),
    tanggal: tanggal || ctx.today, gram: gram };
  p.aset = tgLinkAsset_(p, raw, ctx);
  return p;
}

/** Hubungkan ke aset: "dari X" (dibayar dari / ambil dari), "ke X" (setor), kategori bernama sama dana khusus, emas (gram), menabung. */
function tgLinkAsset_(p, raw, ctx) {
  const simpanan = ctx.assets.filter(function (a) { return a.jenis !== 'Kas utama' && a.nama; });
  const low = ' ' + String(raw).toLowerCase().replace(/\s+/g, ' ') + ' ';
  const keluar = p.jenis === 'pengeluaran';
  const byLen = simpanan.slice().sort(function (a, b) { return b.nama.length - a.nama.length; });
  const has = function (prefix) { return byLen.filter(function (a) { return low.indexOf(' ' + prefix + ' ' + a.nama.toLowerCase() + ' ') >= 0; })[0]; };
  let a = has('dari');
  if (a) return { asetId: a.id, gram: p.gram, arah: keluar ? 'bayar' : 'tarik' };
  a = has('ke');
  if (a) return { asetId: a.id, gram: p.gram, arah: keluar ? 'setor' : 'terima' };
  a = simpanan.filter(function (x) { return x.nama.toLowerCase() === String(p.kategori || '').toLowerCase(); })[0];
  if (a) return { asetId: a.id, gram: 0, arah: keluar ? 'bayar' : 'terima' };
  if (p.gram) {
    const emas = simpanan.filter(function (x) { return x.jenis === 'Emas'; })[0];
    if (emas) return { asetId: emas.id, gram: p.gram, arah: keluar ? 'setor' : 'tarik' };
  }
  if ((keluar && TG_SAVING_RE.test(p.kategori || '')) || (!keluar && TG_WITHDRAW_RE.test(p.kategori || ''))) {
    const pool = simpanan.filter(function (x) { return x.jenis !== 'Dana khusus' && x.jenis !== 'Emas'; });
    if (pool.length === 1) return { asetId: pool[0].id, gram: 0, arah: keluar ? 'setor' : 'tarik' };
  }
  return null;
}

// ---------- mencatat ----------
function tgRecord_(token, chatId, text) {
  const ctx = tgCtx_();
  const parts = tgSplit_(text);
  const saved = [], gagal = [];
  parts.forEach(function (part) {
    const p = tgParse_(part, ctx);
    if (!p.nominal) { gagal.push(part); return; }
    const tx = { id: Utilities.getUuid(), jenis: p.jenis, tanggal: p.tanggal, kategori: p.kategori, keterangan: p.keterangan,
      nominal: p.nominal, aset: p.aset };
    withLock_(function () { return addTx_(tx); });
    saved.push({ tx: tx, guessed: p.guessed });
  });
  if (saved.length) {
    PropertiesService.getScriptProperties().setProperty(TG_P.lastTx, JSON.stringify(saved.map(function (s) { return s.tx.id; })));
    const fresh = tgCtx_();
    fresh.all = tgAllTx_();
    saved.forEach(function (s) {
      const kb = s.guessed ? tgButtons_(s.tx.id) : tgCatButtons_(s.tx.id, s.tx.jenis, fresh, true);
      tgSend_(token, chatId, tgTxText_(s.tx, fresh, s.guessed), kb);
    });
  }
  if (gagal.length) {
    tgSend_(token, chatId, '🤔 Nominalnya tidak ketemu di: <i>' + tgH_(gagal.join(' / ')) + '</i>\nContoh: <i>makan siang 25rb</i> atau <i>bensin 50.000</i>. Ketik /bantuan untuk panduan.');
  }
}

function tgButtons_(id) {
  return [[{ text: '↩️ Batal', callback_data: 'x:' + id }, { text: '🏷️ Ganti kategori', callback_data: 'k:' + id }]];
}

function tgCatButtons_(id, jenis, ctx, withUndo) {
  const list = (ctx.cats[jenis] || []).slice(0, 24);
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map(function (c, k) { return { text: tgEmoji_(c, jenis) + ' ' + c, callback_data: 'c:' + id + ':' + (i + k) }; }));
  }
  rows.push(withUndo ? [{ text: '↩️ Batal', callback_data: 'x:' + id }] : [{ text: '« Kembali', callback_data: 'b:' + id }]);
  return rows;
}

function tgTxText_(tx, ctx, guessed) {
  const masuk = tx.jenis === 'pemasukan';
  const lines = [(masuk ? '💰 <b>Pemasukan ' : '✅ <b>Pengeluaran ') + tgRp_(tx.nominal) + '</b>',
    tgEmoji_(tx.kategori, tx.jenis) + ' ' + tgH_(tx.kategori) + (tx.keterangan ? ' — ' + tgH_(tx.keterangan) : ''),
    '📅 ' + tgDay_(tx.tanggal, ctx.today)];
  if (tx.aset && tx.aset.asetId) {
    const a = ctx.assets.filter(function (x) { return x.id === tx.aset.asetId; })[0];
    if (a) {
      const sisa = tgAssetValue_(a, ctx);
      const kata = { setor: 'Masuk ke', bayar: 'Dibayar dari', tarik: 'Diambil dari', terima: 'Langsung masuk ke' }[tx.aset.arah] || 'Aset:';
      lines.push('🏦 ' + kata + ' ' + tgH_(a.nama) + ' · saldo ' + tgRp_(sisa) +
        (tx.aset.arah === 'bayar' || tx.aset.arah === 'terima' ? ' (uang harian tidak berubah)' : ''));
    }
  }
  if (!masuk) {
    const cyc = tgCycle_(tx.tanggal, ctx.settings.awalSiklus);
    const plan = getPlans_()[cyc.from] || {};
    const item = plan[tx.kategori];
    if (item && item.jatah) {
      const pakai = (ctx.all || []).filter(function (t) { return t.jenis === 'pengeluaran' && t.kategori === tx.kategori && t.tanggal >= cyc.from && t.tanggal <= cyc.to; })
        .reduce(function (s, t) { return s + t.nominal; }, 0);
      const sisa = item.jatah - pakai;
      if (TG_SAVING_RE.test(tx.kategori)) lines.push('🎯 ' + tgH_(tx.kategori) + ' ' + cyc.label + ': ' + tgRp_(pakai) + ' dari ' + tgRp_(item.jatah) + (sisa <= 0 ? ' ✅' : ''));
      else lines.push(sisa >= 0 ? '🎯 Sisa rencana ' + tgH_(tx.kategori) + ': <b>' + tgRp_(sisa) + '</b> dari ' + tgRp_(item.jatah)
        : '⚠️ Rencana ' + tgH_(tx.kategori) + ' lewat <b>' + tgRp_(-sisa) + '</b> (jatah ' + tgRp_(item.jatah) + ')');
    }
  }
  if (!guessed) lines.push('\n🏷️ Kategorinya belum ketebak, jadi masuk <b>' + tgH_(tx.kategori) + '</b>. Pilih yang benar:');
  return lines.join('\n');
}

function tgAssetValue_(a, ctx) {
  const ms = ctx.mutasi.filter(function (m) { return m.asetId === a.id && m.tanggal >= a.mulai; });
  if (a.jenis === 'Emas') {
    const g = a.gramAwal + ms.reduce(function (s, m) { return s + (m.gram || 0); }, 0);
    return Math.round(g * a.harga);
  }
  return a.saldoAwal + ms.reduce(function (s, m) { return s + (m.nominal || 0); }, 0);
}

// ---------- tombol ----------
function tgCallback_(token, cq) {
  const props = PropertiesService.getScriptProperties();
  const owner = props.getProperty(TG_P.owner);
  const chatId = cq.message && cq.message.chat ? String(cq.message.chat.id) : '';
  const answer = function (t) { tgApi_(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: t || '' }); };
  if (!owner || String(cq.from && cq.from.id) !== owner || chatId !== owner) return answer('Bot ini privat.');
  const m = String(cq.data || '').match(/^([xkcb]):([0-9a-f-]{36})(?::(\d+))?$/);
  if (!m) return answer();
  const id = m[2], msgId = cq.message.message_id;
  const found = findById_(id);
  if (!found) {
    answer('Transaksi sudah tidak ada.');
    return tgApi_(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
  }
  const tx = rowToTx_(found.c, found.values, found.row);
  const ctx = tgCtx_();
  const link = ctx.mutasi.filter(function (x) { return x.ref === id; })[0];
  const ARAH_OF = { Setor: 'setor', Bayar: 'bayar', Tarik: 'tarik', Terima: 'terima' };
  tx.aset = link ? { asetId: link.asetId, gram: Math.abs(link.gram || 0), arah: ARAH_OF[link.jenis] || null } : null;
  if (m[1] === 'x') {
    withLock_(function () { return deleteTx_({ id: id }); });
    answer('Dibatalkan');
    return tgApi_(token, 'editMessageText', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
      text: '↩️ <s>' + tgH_(tx.kategori + ' ' + tgRp_(tx.nominal) + (tx.keterangan ? ' — ' + tx.keterangan : '')) + '</s>\nDibatalkan, sudah dihapus dari sheet.' });
  }
  if (m[1] === 'k') {
    answer();
    return tgApi_(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: tgCatButtons_(id, tx.jenis, ctx, false) } });
  }
  if (m[1] === 'b') {
    answer();
    return tgApi_(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: tgButtons_(id) } });
  }
  // c: ganti kategori
  const baru = (ctx.cats[tx.jenis] || [])[Number(m[3])];
  if (!baru) return answer('Kategori tidak ditemukan.');
  tx.kategori = baru;
  if (!tx.aset) tx.aset = tgLinkAsset_({ jenis: tx.jenis, kategori: baru, gram: 0 }, '', ctx);
  withLock_(function () { return updateTx_(tx); });
  answer('Kategori: ' + baru);
  const fresh = tgCtx_();
  fresh.all = tgAllTx_();
  return tgApi_(token, 'editMessageText', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', text: tgTxText_(tx, fresh, true),
    reply_markup: { inline_keyboard: tgButtons_(id) } });
}

function tgUndo_(token, chatId) {
  const props = PropertiesService.getScriptProperties();
  let ids = [];
  try { ids = JSON.parse(props.getProperty(TG_P.lastTx) || '[]'); } catch (e) { ids = []; }
  if (!ids.length) return tgSend_(token, chatId, 'Tidak ada catatan dari chat yang bisa dibatalkan. Hapus lewat aplikasi bila perlu.');
  const hapus = [];
  ids.forEach(function (id) {
    const f = findById_(id);
    if (!f) return;
    const t = rowToTx_(f.c, f.values, f.row);
    withLock_(function () { return deleteTx_({ id: id }); });
    hapus.push(t.kategori + ' ' + tgRp_(t.nominal));
  });
  props.deleteProperty(TG_P.lastTx);
  return tgSend_(token, chatId, hapus.length ? '↩️ Dihapus: ' + tgH_(hapus.join(', ')) : 'Catatan terakhir sudah tidak ada.');
}

// ---------- rekap ----------
function tgRekap_() {
  const ctx = tgCtx_();
  const all = tgAllTx_();
  const cyc = tgCycle_(ctx.today, ctx.settings.awalSiklus);
  const inCyc = all.filter(function (t) { return t.tanggal >= cyc.from && t.tanggal <= cyc.to; });
  const linkJ = {};
  ctx.mutasi.forEach(function (m) { if (m.ref) linkJ[m.ref] = m.jenis; });
  let masuk = 0, ambil = 0, keluar = 0, tabung = 0;
  const perCat = {};
  inCyc.forEach(function (t) {
    if (t.jenis === 'pemasukan') {
      masuk += t.nominal;
      if (linkJ[t.id] === 'Tarik' || (!linkJ[t.id] && TG_WITHDRAW_RE.test(t.kategori))) ambil += t.nominal;
    } else {
      keluar += t.nominal;
      if (linkJ[t.id] === 'Setor' || (!linkJ[t.id] && TG_SAVING_RE.test(t.kategori))) tabung += t.nominal;
      else perCat[t.kategori] = (perCat[t.kategori] || 0) + t.nominal;
    }
  });
  const L = ['📊 <b>Rekap ' + tgH_(cyc.label) + '</b>',
    'Pemasukan: <b>' + tgRp_(masuk - ambil) + '</b>' + (ambil ? ' (+ ambil tabungan ' + tgRp_(ambil) + ')' : ''),
    'Pengeluaran: <b>' + tgRp_(keluar - tabung) + '</b>',
    'Ditabung: <b>' + tgRp_(tabung) + '</b>',
    'Sisa uang: <b>' + tgRp_(masuk - keluar) + '</b>'];
  const top = Object.keys(perCat).sort(function (a, b) { return perCat[b] - perCat[a]; }).slice(0, 6);
  if (top.length) {
    L.push('', '<b>Pengeluaran terbesar</b>');
    top.forEach(function (k) { L.push(tgEmoji_(k, 'pengeluaran') + ' ' + tgH_(k) + ': ' + tgRp_(perCat[k])); });
  }
  const plan = getPlans_()[cyc.from] || {};
  const pk = Object.keys(plan);
  if (pk.length) {
    L.push('', '<b>Rencana</b>');
    pk.sort(function (a, b) { return plan[b].jatah - plan[a].jatah; }).slice(0, 12).forEach(function (k) {
      const pakai = inCyc.filter(function (t) { return t.jenis === 'pengeluaran' && t.kategori === k; }).reduce(function (s, t) { return s + t.nominal; }, 0);
      const j = plan[k].jatah, saving = TG_SAVING_RE.test(k);
      const tanda = plan[k].lunas || (saving && pakai >= j) ? '✅' : pakai > j ? '⚠️' : '▫️';
      L.push(tanda + ' ' + tgH_(k) + ': ' + tgRp_(pakai) + ' / ' + tgRp_(j) + (!saving && pakai <= j && !plan[k].lunas ? ' · sisa ' + tgRp_(j - pakai) : ''));
    });
  }
  const hari = all.filter(function (t) { return t.tanggal === ctx.today && t.jenis === 'pengeluaran'; });
  L.push('', 'Hari ini: ' + tgRp_(hari.reduce(function (s, t) { return s + t.nominal; }, 0)) + ' (' + hari.length + ' catatan) · /hariini');
  return L.join('\n');
}

function tgToday_() {
  const ctx = tgCtx_();
  const list = tgAllTx_().filter(function (t) { return t.tanggal === ctx.today; });
  if (!list.length) return 'Belum ada catatan hari ini.';
  const keluar = list.filter(function (t) { return t.jenis === 'pengeluaran'; }).reduce(function (s, t) { return s + t.nominal; }, 0);
  return '🗓️ <b>Hari ini</b>\n' + list.slice(-20).map(function (t) {
    return (t.jenis === 'pemasukan' ? '+ ' : '− ') + tgEmoji_(t.kategori, t.jenis) + ' ' + tgH_(t.kategori) + (t.keterangan ? ' (' + tgH_(t.keterangan) + ')' : '') + ': ' + tgRp_(t.nominal);
  }).join('\n') + '\n\nTotal pengeluaran: <b>' + tgRp_(keluar) + '</b>';
}

// ---------- format ----------
const TG_EMOJI = [[/zakat/i, '🕌'], [/travel|liburan|wisata|jalan-jalan/i, '✈️'], [/makan|minum|kuliner|food|jajan/i, '🍜'],
  [/transport|bensin|kendaraan/i, '🛵'], [/belanja|shopping/i, '🛍️'], [/tagihan|utilitas|listrik/i, '💡'], [/hiburan|rekreasi/i, '🎬'],
  [/kesehatan|medis/i, '💊'], [/pendidikan|edukasi|sekolah/i, '📚'], [/sosial|donasi|amal/i, '🤝'], [/gaji/i, '💼'], [/bonus|thr/i, '🎁'],
  [/freelance|proyek/i, '💻'], [/investasi|dividen|tabung|nabung/i, '📈'], [/asuransi/i, '🛡️'], [/pulsa|internet|kuota/i, '📶'],
  [/langganan|claude|netflix|spotify/i, '🔁'], [/rumah|sewa|kos/i, '🏠'], [/cicilan|utang|hutang|kredit/i, '💳'], [/pakaian|fashion/i, '👕'],
  [/orang ?tua|ortu|anak|keluarga/i, '👪']];
function tgEmoji_(name, jenis) {
  const hit = TG_EMOJI.filter(function (x) { return x[0].test(name || ''); })[0];
  return hit ? hit[1] : (jenis === 'pemasukan' ? '💰' : '📦');
}
function tgRp_(n) {
  n = Math.round(Number(n) || 0);
  return (n < 0 ? '−' : '') + 'Rp ' + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function tgH_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function tgDay_(ymd, today) {
  if (ymd === today) return 'Hari ini';
  if (ymd === tgAddDays_(today, -1)) return 'Kemarin';
  return +ymd.slice(8, 10) + ' ' + TG_BLN[+ymd.slice(5, 7) - 1] + ' ' + ymd.slice(0, 4);
}
