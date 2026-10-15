const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
require('dotenv').config();

const db = require('./config/db');
const { PRODI_LIST, isValidProdi } = require('./config/prodi');
const { signToken, requireAuth, requireRole } = require('./middleware/auth');
const { uploadKtm, fileToBase64 } = require('./middleware/uploadKtm');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Sajikan file frontend secara statis
app.use(express.static(path.join(__dirname, '../frontend')));

const sendErr = (res, code, message) => res.status(code).json({ success: false, message });

const audit = async (actorId, action, targetType, targetId, detail) => {
  try {
    await db.query(
      'INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)',
      [actorId || null, action, targetType || null, targetId || null, detail || null]
    );
  } catch (e) {
    console.warn('audit gagal:', e.message);
  }
};

const publicUser = (u) => {
  if (!u) return u;
  const { password_hash, password, ...rest } = u; // jangan pernah kirim hash
  return rest;
};

// Rate-limit login + register (PRD §8)
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

// ==========================================
// 0. DAFTAR PRODI (PRD §3, dipakai dropdown frontend)
// ==========================================
app.get('/api/prodi', (_req, res) => {
  res.json({ success: true, data: PRODI_LIST });
});

// ==========================================
// 1. ROUTE KATEGORI
// ==========================================
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM categories ORDER BY id ASC');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 2. ROUTE LAPORAN KEHILANGAN (LOST REPORTS)
// Label admin: "Laporan Barang Hilang Masuk"
// ==========================================
app.get('/api/reports', async (req, res) => {
  try {
    const { status, user_id } = req.query;
    let query = `
      SELECT r.*, c.name AS category_name, u.name AS user_name, u.nim, u.prodi
      FROM lost_reports r
      JOIN categories c ON r.category_id = c.id
      JOIN users u ON r.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND r.status = ?';
      params.push(status);
    }
    if (user_id) {
      query += ' AND r.user_id = ?';
      params.push(user_id);
    }

    query += ' ORDER BY r.created_at DESC';

    const [rows] = await db.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Tambah laporan kehilangan baru (mahasiswa login)
app.post(
  '/api/reports',
  requireAuth,
  requireRole('user'),
  [
    body('category_id').isInt({ min: 1 }),
    body('item_name').trim().notEmpty(),
    body('color').trim().notEmpty(),
    body('building').isIn(['Gedung A', 'Gedung B']),
    body('lost_location').trim().notEmpty(),
    body('lost_date').isDate(),
    body('description').trim().notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendErr(res, 400, 'Data laporan belum lengkap / tidak valid.');

    try {
      const {
        category_id,
        item_name,
        color,
        brand,
        building,
        lost_location,
        classroom_number,
        lost_date,
        description,
        photo,
      } = req.body;

      const [result] = await db.query(
        `INSERT INTO lost_reports
        (user_id, category_id, item_name, color, brand, building, lost_location, classroom_number, lost_date, description, photo, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
        [
          req.auth.id,
          category_id,
          item_name,
          color,
          brand || '',
          building,
          lost_location,
          classroom_number || null,
          lost_date,
          description,
          photo || '',
        ]
      );

      res.status(201).json({
        success: true,
        message: 'Laporan barang hilang diterima, menunggu verifikasi Admin.',
        id: result.insertId,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ACC / tolak laporan hilang (admin)
app.patch('/api/reports/:id/approve', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { approve, reason } = req.body;
    const status = approve === false ? 'REJECTED' : 'ACTIVE';
    const now = new Date();
    const expired = new Date(now);
    expired.setDate(expired.getDate() + 3);
    await db.query(
      'UPDATE lost_reports SET status = ?, approved_at = ?, expired_at = ? WHERE id = ?',
      approve === false ? [status, null, null, req.params.id] : [status, now, expired, req.params.id]
    );
    await audit(req.auth.id, approve === false ? 'report.reject' : 'report.approve', 'lost_reports', req.params.id, reason || null);
    res.json({ success: true, message: approve === false ? 'Laporan barang hilang ditolak.' : 'Laporan barang hilang disetujui, aktif 3 hari di forum.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 3. ROUTE BARANG TEMUAN (FOUND ITEMS)
// Label admin: "Laporan Barang Ditemukan Masuk"
// ==========================================
app.get('/api/found', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT f.*, c.name AS category_name
      FROM found_items f
      JOIN categories c ON f.category_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND f.status = ?';
      params.push(status);
    }

    query += ' ORDER BY f.created_at DESC';

    const [rows] = await db.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Tambah barang temuan (petugas/admin login)
app.post(
  '/api/found',
  requireAuth,
  requireRole('petugas', 'admin'),
  [
    body('category_id').isInt({ min: 1 }),
    body('item_name').trim().notEmpty(),
    body('building').isIn(['Gedung A', 'Gedung B']),
    body('found_location').trim().notEmpty(),
    body('found_date').isDate(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendErr(res, 400, 'Data barang temuan belum lengkap / tidak valid.');
    try {
      const {
        category_id,
        item_name,
        color,
        brand,
        building,
        found_location,
        classroom_number,
        found_date,
        description,
        photo,
      } = req.body;

      const isAdmin = req.auth.role === 'admin';
      const status = isAdmin ? 'APPROVED' : 'PENDING_APPROVAL';

      const [me] = await db.query('SELECT name FROM users WHERE id = ?', [req.auth.id]);
      const myName = (me[0] && me[0].name) || 'Staf';

      const [result] = await db.query(
        `INSERT INTO found_items
        (category_id, item_name, color, brand, building, found_location, classroom_number, found_date, description, photo, status, received_by_id, received_by_name, approved_by_id, approved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          category_id,
          item_name,
          color || '',
          brand || '',
          building,
          found_location,
          classroom_number || null,
          found_date,
          description || '',
          photo || '',
          status,
          req.auth.id,
          isAdmin ? 'Admin Kemahasiswaan' : `Petugas - ${myName}`,
          isAdmin ? req.auth.id : null,
          isAdmin ? new Date() : null,
        ]
      );

      res.status(201).json({
        success: true,
        message: isAdmin ? 'Barang temuan dicatat (APPROVED).' : 'Barang temuan dicatat, menunggu ACC Admin.',
        id: result.insertId,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ACC / tolak barang temuan (admin)
app.patch('/api/found/:id/approve', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { approve } = req.body;
    if (approve === false) {
      await db.query('UPDATE found_items SET status = ? WHERE id = ?', ['REJECTED', req.params.id]);
      await audit(req.auth.id, 'found.reject', 'found_items', req.params.id, null);
      return res.json({ success: true, message: 'Laporan barang ditemukan ditolak.' });
    }
    await db.query('UPDATE found_items SET status = ?, approved_by_id = ?, approved_at = ? WHERE id = ?', [
      'APPROVED',
      req.auth.id,
      new Date(),
      req.params.id,
    ]);
    await audit(req.auth.id, 'found.approve', 'found_items', req.params.id, null);
    res.json({ success: true, message: 'Laporan barang ditemukan disetujui (ACC).' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4. MATCH + RETURN (admin, catat audit)
// ==========================================
app.get('/api/matches', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM matches ORDER BY matched_at DESC');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/matches', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { lost_report_id, found_item_id, notes } = req.body;
    if (!lost_report_id || !found_item_id) return sendErr(res, 400, 'Pilih laporan hilang dan barang temuan.');
    const [r] = await db.query(
      'INSERT INTO matches (lost_report_id, found_item_id, matched_by_id, notes) VALUES (?, ?, ?, ?)',
      [lost_report_id, found_item_id, req.auth.id, notes || null]
    );
    await db.query('UPDATE lost_reports SET status = ? WHERE id = ?', ['FOUND', lost_report_id]);
    await db.query('UPDATE found_items SET status = ? WHERE id = ?', ['MATCHED', found_item_id]);
    await audit(req.auth.id, 'match.create', 'matches', r.insertId, notes || null);
    res.status(201).json({ success: true, message: 'Berhasil dicocokkan.', id: r.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/returns', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const {
      lost_report_id, found_item_id, user_id, notes,
      taker_name, taker_nim, taker_prodi, taker_phone,
      taker_photo, taker_receipt, taker_selfie,
      check_1_details, check_2_contents, check_3_proof, check_4_identity, check_5_signed,
    } = req.body;
    if (!lost_report_id || !user_id) return sendErr(res, 400, 'Data pengembalian belum lengkap.');
    const [r] = await db.query(
      `INSERT INTO returns
      (lost_report_id, found_item_id, user_id, verified_by_id, notes,
       taker_name, taker_nim, taker_prodi, taker_phone, taker_photo, taker_receipt, taker_selfie,
       check_1_details, check_2_contents, check_3_proof, check_4_identity, check_5_signed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lost_report_id, found_item_id || null, user_id, req.auth.id, notes || null,
        taker_name || null, taker_nim || null, taker_prodi || null, taker_phone || null,
        taker_photo || null, taker_receipt || null, taker_selfie || null,
        check_1_details !== false, check_2_contents !== false, check_3_proof !== false,
        check_4_identity !== false, check_5_signed !== false,
      ]
    );
    await db.query('UPDATE lost_reports SET status = ? WHERE id = ?', ['RETURNED', lost_report_id]);
    if (found_item_id) await db.query('UPDATE found_items SET status = ? WHERE id = ?', ['RETURNED', found_item_id]);
    await audit(req.auth.id, 'return.create', 'returns', r.insertId, notes || null);
    res.status(201).json({ success: true, message: 'Barang diserahkan (RETURNED).', id: r.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 5. AUTH SATU PINTU (PRD §6: bcrypt + JWT + status verifikasi)
// identifier = NIM (user) ATAU username (petugas/admin)
// ==========================================
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const identifier = String(req.body.identifier || req.body.nim || req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!identifier || !password) return sendErr(res, 400, 'NIM/username dan kata sandi wajib diisi.');

    const key = identifier.toLowerCase();
    const [rows] = await db.query(
      'SELECT * FROM users WHERE (role = "user" AND nim = ?) OR (role IN ("petugas","admin") AND LOWER(username) = ?)',
      [identifier, key]
    );
    if (rows.length === 0) return sendErr(res, 401, 'Akun tidak ditemukan. Periksa NIM/username Anda.');

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || '');
    if (!ok) return sendErr(res, 401, 'Kata sandi salah.');

    // Mahasiswa wajib sudah ACTIVE (Cara B). Staf selalu ACTIVE dari seed.
    if (user.role === 'user' && user.verification_status !== 'ACTIVE') {
      if (user.verification_status === 'PENDING') {
        return sendErr(res, 403, 'Akun menunggu verifikasi Admin. Tunggu ACC setelah upload KTM.');
      }
      return sendErr(res, 403, `Pendaftaran ditolak Admin${user.rejected_reason ? `: ${user.rejected_reason}` : '.'}`);
    }

    const token = signToken(user);
    res.json({ success: true, message: 'Login berhasil.', token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Regist mahasiswa Cara B: multipart (data + file ktm), status PENDING, tanpa auto-login
app.post('/api/auth/register', authLimiter, (req, res) => {
  uploadKtm(req, res, async (upErr) => {
    try {
      if (upErr) return sendErr(res, 400, upErr.message);
      const name = String(req.body.name || '').trim();
      const nim = String(req.body.nim || '').trim();
      const prodi = String(req.body.prodi || '').trim();
      const password = String(req.body.password || '');
      const confirm = String(req.body.confirm || req.body.password_confirm || '');

      if (!name || !nim || !prodi || !password) return sendErr(res, 400, 'Lengkapi nama, NIM, prodi, kata sandi, dan foto KTM.');
      if (!/^[0-9]{5,15}$/.test(nim)) return sendErr(res, 400, 'NIM harus berupa angka (5-15 digit).');
      if (!isValidProdi(prodi)) return sendErr(res, 400, 'Program studi tidak dikenal. Pilih dari daftar resmi.');
      if (password.length < 6) return sendErr(res, 400, 'Kata sandi minimal 6 karakter.');
      if (confirm && confirm !== password) return sendErr(res, 400, 'Konfirmasi kata sandi tidak sama.');
      if (!req.file) return sendErr(res, 400, 'Foto KTM wajib diunggah (JPG/PNG/WEBP, maks 5 MB).');

      const [existing] = await db.query('SELECT id FROM users WHERE nim = ?', [nim]);
      if (existing.length > 0) {
        return sendErr(res, 400, 'NIM sudah terdaftar. Silakan masuk.');
      }

      const hash = await bcrypt.hash(password, 10);
      // Simpan foto KTM sebagai base64 data URL langsung ke database
      const ktmBase64 = fileToBase64(req.file);

      const [result] = await db.query(
        'INSERT INTO users (name, nim, prodi, password_hash, role, verification_status, ktm_photo) VALUES (?, ?, ?, ?, "user", "PENDING", ?)',
        [name, nim, prodi, hash, ktmBase64]
      );
      await audit(null, 'regist.pending', 'users', result.insertId, `NIM ${nim}`);

      res.status(201).json({
        success: true,
        message: 'Pendaftaran diterima. Akun menunggu verifikasi Admin.',
        user: { id: result.insertId, name, nim, prodi, role: 'user', verification_status: 'PENDING' },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
});

// Antrian regist PENDING (admin)
app.get('/api/auth/pending-registrations', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, nim, prodi, ktm_photo, verification_status, created_at FROM users WHERE role = "user" AND verification_status = "PENDING" ORDER BY created_at ASC'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ACC / tolak regist (admin)
app.post('/api/auth/verify-registration', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { user_id, approve, reason } = req.body;
    if (!user_id) return sendErr(res, 400, 'user_id wajib diisi.');
    if (approve === false && !String(reason || '').trim()) {
      return sendErr(res, 400, 'Alasan penolakan wajib diisi.');
    }
    const status = approve === false ? 'REJECTED' : 'ACTIVE';
    await db.query(
      'UPDATE users SET verification_status = ?, rejected_reason = ?, verified_by_id = ?, verified_at = ? WHERE id = ? AND role = "user"',
      [status, approve === false ? String(reason).trim() : null, req.auth.id, new Date(), user_id]
    );
    await audit(req.auth.id, approve === false ? 'regist.reject' : 'regist.approve', 'users', user_id, reason || null);
    res.json({
      success: true,
      message: approve === false ? 'Pendaftaran ditolak.' : 'Pendaftaran disetujui. Mahasiswa bisa masuk.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Profil akun dari token (untuk restore sesi setelah refresh)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [req.auth.id]);
    if (rows.length === 0) return sendErr(res, 401, 'Akun tidak ditemukan.');
    res.json({ success: true, user: publicUser(rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4b. USERS (admin: daftar mahasiswa/petugas untuk Data Master + chat)
// ==========================================
app.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { role, status } = req.query;
    let q = 'SELECT id, name, nim, prodi, username, role, verification_status, ktm_photo, rejected_reason, created_at FROM users WHERE 1=1';
    const params = [];
    if (role) { q += ' AND role = ?'; params.push(role); }
    if (status) { q += ' AND verification_status = ?'; params.push(status); }
    q += ' ORDER BY created_at ASC';
    const [rows] = await db.query(q, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4c. HAPUS LAPORAN / TEMUAN (ganti reset global: hapus per-item + audit)
// ==========================================
app.delete('/api/reports/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM lost_reports WHERE id = ?', [req.params.id]);
    await audit(req.auth.id, 'report.delete', 'lost_reports', req.params.id, null);
    res.json({ success: true, message: 'Laporan kehilangan dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/found/:id', requireAuth, requireRole('admin', 'petugas'), async (req, res) => {
  try {
    if (req.auth.role === 'petugas') {
      const [rows] = await db.query('SELECT received_by_id FROM found_items WHERE id = ?', [req.params.id]);
      if (!rows.length) return sendErr(res, 404, 'Data tidak ditemukan.');
      if (rows[0].received_by_id !== req.auth.id) return sendErr(res, 403, 'Anda hanya boleh menghapus barang yang Anda terima.');
    }
    await db.query('DELETE FROM found_items WHERE id = ?', [req.params.id]);
    await audit(req.auth.id, 'found.delete', 'found_items', req.params.id, null);
    res.json({ success: true, message: 'Barang temuan dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4d. CHAT / PESAN (ganti mock localStorage + auto-reply palsu)
// ==========================================
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.query;
    let q = `SELECT m.*, r.item_name AS report_name FROM messages m LEFT JOIN lost_reports r ON m.report_id = r.id WHERE 1=1`;
    const params = [];
    if (req.auth.role === 'user') {
      q += ' AND m.user_id = ?';
      params.push(req.auth.id);
    } else if (user_id) {
      q += ' AND m.user_id = ?';
      params.push(user_id);
    }
    q += ' ORDER BY m.created_at ASC';
    const [rows] = await db.query(q, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/messages', requireAuth, requireRole('user', 'admin'), async (req, res) => {
  try {
    const text = String(req.body.message || req.body.text || '').trim();
    const reportId = req.body.report_id || req.body.rid || null;
    let uid = req.body.user_id || null;
    if (req.auth.role === 'user') uid = req.auth.id;
    if (!uid) return sendErr(res, 400, 'Pilih mahasiswa tujuan chat.');
    if (!text) return sendErr(res, 400, 'Pesan tidak boleh kosong.');
    const [r] = await db.query(
      'INSERT INTO messages (user_id, sender_role, sender_id, report_id, message) VALUES (?, ?, ?, ?, ?)',
      [uid, req.auth.role === 'admin' ? 'admin' : 'user', req.auth.id, reportId, text]
    );
    res.status(201).json({ success: true, id: r.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/messages/read', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.body;
    const uid = req.auth.role === 'admin' ? user_id : req.auth.id;
    if (!uid) return sendErr(res, 400, 'user_id wajib diisi.');
    const other = req.auth.role === 'admin' ? 'user' : 'admin';
    await db.query('UPDATE messages SET is_read = TRUE WHERE user_id = ? AND sender_role = ?', [uid, other]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4e. RETURNS (lengkap: cek 5 poin + data pengambil, ganti mock)
// ==========================================
app.get('/api/returns', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { lost_report_id } = req.query;
    let q = 'SELECT * FROM returns WHERE 1=1';
    const params = [];
    if (lost_report_id) { q += ' AND lost_report_id = ?'; params.push(lost_report_id); }
    q += ' ORDER BY returned_at DESC';
    const [rows] = await db.query(q, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4f. FOTO KTM
// Baru: base64 di database. Lama: file di backend/uploads/ktm.
// Endpoint ini melayani keduanya agar data lama tidak "Cannot GET".
// - base64 (data:image/...) -> decode langsung dari DB
// - file fisik masih ada di disk -> kirim file
// - keduanya hilang -> placeholder SVG 404 (bukan "Cannot GET")
// Hanya pemilik akun + admin.
// ==========================================
// 1x1 transparent PNG fallback untuk <img> yang KTM-nya hilang
const KTM_PLACEHOLDER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const serveKtmImage = async (req, res) => {
  try {
    const file = path.basename(req.params.file || req.params[0] || '');
    if (!file) return res.status(400).json({ success: false, message: 'Nama file KTM tidak valid.' });

    const [rows] = await db.query('SELECT id, ktm_photo FROM users WHERE ktm_photo LIKE ?', [`%${file}%`]);
    const owner = rows[0];
    if (!owner) {
      // Data sudah tidak ada di DB -> placeholder agar <img> tidak rusak
      if ((req.headers.accept || '').includes('image')) {
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        return res.send(KTM_PLACEHOLDER);
      }
      return sendErr(res, 404, 'Foto KTM tidak ditemukan (data lama sudah tidak tersedia).');
    }
    if (req.auth.role !== 'admin' && req.auth.id !== owner.id) {
      return sendErr(res, 403, 'Anda tidak memiliki izin membuka foto ini.');
    }

    // Kasus baru: base64 data URL di DB -> decode dan kirim sebagai gambar
    const stored = String(owner.ktm_photo || '');
    const m = stored.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (m) {
      const buf = Buffer.from(m[2], 'base64');
      res.set('Content-Type', m[1]);
      res.set('Cache-Control', 'private, max-age=3600');
      return res.send(buf);
    }

    // Kasus lama: path file -> kirim file fisik bila masih ada di disk.
    // Normalisasi: DB lama berisi "backend/uploads/ktm/xxx" atau "/backend/uploads/ktm/xxx".
    const storedPath = String(owner.ktm_photo || '').replace(/^\/+/, '');
    const candidates = [
      path.join(__dirname, 'uploads', 'ktm', file),
      path.join(__dirname, '..', 'backend', 'uploads', 'ktm', file),
      path.join(__dirname, '..', storedPath),
      path.resolve(__dirname, '..', '..', storedPath),
    ];
    for (const full of candidates) {
      try {
        if (full && fs.existsSync(full) && fs.statSync(full).isFile()) {
          return res.sendFile(path.resolve(full));
        }
      } catch (_) {}
    }

    // File fisik sudah hilang -> placeholder agar <img> tidak rusak
    if ((req.headers.accept || '').includes('image')) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'no-store');
      return res.send(KTM_PLACEHOLDER);
    }
    return sendErr(res, 404, 'File KTM lama sudah tidak tersedia di server. Minta mahasiswa daftar ulang.');
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Route kanonis
app.get('/uploads/ktm/:file', requireAuth, serveKtmImage);
// Kompatibilitas URL lama yang diawali /backend/... (penyebab "Cannot GET /backend/uploads/ktm/...")
app.get('/backend/uploads/ktm/:file', requireAuth, serveKtmImage);

// Jalankan Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(` Server API Express.js berjalan!`);
    console.log(` Port    : http://localhost:${PORT}`);
    console.log(` Frontend: http://localhost:${PORT}/index.html`);
    console.log(`=========================================`);
  });
}

module.exports = app;
