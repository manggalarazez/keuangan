/**
 * ============================================================
 *  API CATATAN KEUANGAN — Google Apps Script (Backend)
 *  Versi 2.1 (rencana bulanan + aset + dana khusus)
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
