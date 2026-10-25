const express = require('express');
const crypto  = require('crypto');
const pool    = require('../db/pool');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'gismo_cerilas_jwt_secret_2026';

// Default Cerilas Netgsm SMS settings (fallback if sms_settings table is empty)
const DEFAULT_SMS_SETTINGS = {
  netgsm_usercode: process.env.NETGSM_USERCODE || '8503044989',
  netgsm_password: process.env.NETGSM_PASSWORD || 'Dnz.24232423',
  netgsm_header:   process.env.NETGSM_HEADER   || 'CERILAS AS',
  is_active:       true,
};

// ─────────────────────────────────────────────
// Helpers: Password Hashing, JWT, Phone Normalization
// ─────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, originalHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const original = Buffer.from(originalHex, 'hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(derived, original);
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input) {
  let str = input.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function signToken(payload, expiresInSeconds = 30 * 24 * 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedBody = base64UrlEncode(JSON.stringify(body));
  const data = `${encodedHeader}.${encodedBody}`;
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${data}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, signature] = parts;
  const data = `${encodedHeader}.${encodedBody}`;
  const expectedSig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  if (signature !== expectedSig) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(encodedBody));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Normalize Turkish mobile number to 10 digits starting with '5' (e.g. "5321234567").
 * Returns null if not a valid 10-digit Turkish mobile number.
 */
function normalizeTurkishPhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  let digits = rawPhone.replace(/\D/g, '');
  if (digits.startsWith('0090') && digits.length === 14) {
    digits = digits.slice(4);
  } else if (digits.startsWith('90') && digits.length === 12) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.slice(1);
  }
  if (digits.length === 10 && digits.startsWith('5')) {
    return digits;
  }
  return null;
}

function formatUser(row) {
  if (!row) return null;
  const fullName =
    (row.full_name || '').trim() ||
    (row.email ? row.email.split('@')[0] : 'Robot Kullanıcısı');
  const rawGoogleId = row.google_id || null;
  const isRealGoogle = Boolean(rawGoogleId && !String(rawGoogleId).startsWith('apple:'));
  return {
    id: row.id,
    full_name: fullName,
    email: row.email || '',
    phone: row.phone ? `0${row.phone}` : '',
    clean_phone: row.phone || '',
    phone_verified: Boolean(row.phone_verified && row.phone),
    google_id: isRealGoogle ? rawGoogleId : null,
    apple_id: row.apple_id || (rawGoogleId && String(rawGoogleId).startsWith('apple:') ? String(rawGoogleId).slice(6) : null),
    is_google_connected: isRealGoogle,
    avatar_url: row.avatar_url || '',
    auth_provider: row.auth_provider || 'phone_email',
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

/**
 * Safely merge two user rows (e.g. when a Phone+Email account and a Google/Apple account share the same email/identity)
 * Keeps targetUser (preferring the row that has a verified phone number), migrates memories/OTPs, and deletes sourceUser.
 */
async function mergeUserAccounts(userA, userB) {
  if (!userA) return userB;
  if (!userB) return userA;
  if (userA.id === userB.id) return userA;

  // Prefer the row that has a phone number attached as primary target
  const target = userA.phone ? userA : (userB.phone ? userB : userA);
  const source = target.id === userA.id ? userB : userA;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Move permanent memories and OTP history to target user
    await client.query(
      'UPDATE user_memories SET user_id = $1 WHERE user_id = $2',
      [target.id, source.id]
    );
    await client.query(
      'UPDATE phone_verification_codes SET user_id = $1 WHERE user_id = $2',
      [target.id, source.id]
    );

    const mergedFullName =
      (target.full_name && !target.full_name.includes('Kullanıcısı') ? target.full_name : null) ||
      (source.full_name && !source.full_name.includes('Kullanıcısı') ? source.full_name : null) ||
      target.full_name ||
      source.full_name;
    const mergedEmail =
      (target.email && !target.email.endsWith('@privaterelay.appleid.com') ? target.email : null) ||
      (source.email && !source.email.endsWith('@privaterelay.appleid.com') ? source.email : null) ||
      target.email ||
      source.email;
    const mergedPhone = target.phone || source.phone || null;
    const mergedPasswordHash = target.password_hash || source.password_hash || null;
    const targetGoogle = target.google_id && !String(target.google_id).startsWith('apple:') ? target.google_id : null;
    const sourceGoogle = source.google_id && !String(source.google_id).startsWith('apple:') ? source.google_id : null;
    const mergedGoogleId = targetGoogle || sourceGoogle || null;
    const mergedAppleId =
      target.apple_id ||
      source.apple_id ||
      (target.google_id && String(target.google_id).startsWith('apple:') ? String(target.google_id).slice(6) : null) ||
      (source.google_id && String(source.google_id).startsWith('apple:') ? String(source.google_id).slice(6) : null) ||
      null;
    const mergedAvatar = target.avatar_url || source.avatar_url || null;
    const mergedPhoneVerified = Boolean(target.phone_verified || source.phone_verified);

    // Delete source row first so UNIQUE constraints (email, phone, google_id, apple_id) don't conflict
    await client.query('DELETE FROM users WHERE id = $1', [source.id]);

    const updated = await client.query(
      `UPDATE users SET
        full_name = $1,
        email = $2,
        phone = $3,
        password_hash = $4,
        google_id = $5,
        apple_id = $6,
        avatar_url = $7,
        phone_verified = $8,
        last_login_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        mergedFullName,
        mergedEmail,
        mergedPhone,
        mergedPasswordHash,
        mergedGoogleId,
        mergedAppleId,
        mergedAvatar,
        mergedPhoneVerified,
        target.id,
      ]
    );

    await client.query('COMMIT');
    console.log(`[Auth Merge] Merged user ${source.id} into ${target.id} (${mergedEmail})`);
    return updated.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Auth Merge] Failed to merge users:', err.message);
    return target;
  } finally {
    client.release();
  }
}

function requireUserAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Oturum anahtarı gerekli.' });
  }
  const token = header.slice(7).trim();
  const decoded = verifyToken(token);
  if (!decoded || !decoded.id) {
    return res.status(401).json({ error: 'Oturum süresi dolmuş veya geçersiz.' });
  }
  req.user = decoded;
  next();
}

// ─────────────────────────────────────────────
// Cerilas Netgsm SMS Sender
// ─────────────────────────────────────────────

async function getSmsSettings() {
  try {
    const res = await pool.query('SELECT * FROM sms_settings LIMIT 1');
    if (res.rows.length > 0) {
      return res.rows[0];
    }
  } catch (err) {
    console.warn('[SMS] sms_settings table read warning:', err.message);
  }
  return DEFAULT_SMS_SETTINGS;
}

async function sendCerilasOtpSms(digits10, code) {
  const settings = await getSmsSettings();
  if (!settings.is_active || !settings.netgsm_usercode || !settings.netgsm_password) {
    return { smsSent: false, error: 'SMS ayarları aktif değil.' };
  }

  const authString = Buffer.from(
    `${settings.netgsm_usercode}:${settings.netgsm_password}`
  ).toString('base64');
  const message = `Gismo dogrulama kodunuz: ${code}. Guvenliginiz icin bu kodu kimseyle paylasmayin.`;

  // 1) Try Netgsm OTP endpoint (same as cerilas.com & tools-app)
  try {
    const otpPayload = {
      msgheader: settings.netgsm_header || 'CERILAS AS',
      msg: message,
      no: digits10,
    };

    const otpRes = await fetch('https://api.netgsm.com.tr/sms/rest/v2/otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${authString}`,
      },
      body: JSON.stringify(otpPayload),
    });

    const otpData = await otpRes.json().catch(() => ({}));
    console.log('[Cerilas SMS OTP] Response:', otpData);

    if (otpData && otpData.code === '00') {
      return { smsSent: true, providerResponse: otpData };
    }

    // 2) Fallback to Netgsm REST v2 /send endpoint if /otp returns non-00
    const sendPayload = {
      msgheader: settings.netgsm_header || 'CERILAS AS',
      messages: [{ msg: message, no: digits10 }],
      encoding: 'TR',
      iysfilter: '0',
    };

    const sendRes = await fetch('https://api.netgsm.com.tr/sms/rest/v2/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${authString}`,
      },
      body: JSON.stringify(sendPayload),
    });

    const sendData = await sendRes.json().catch(() => ({}));
    console.log('[Cerilas SMS Send Fallback] Response:', sendData);

    if (sendData && sendData.code === '00') {
      return { smsSent: true, providerResponse: sendData };
    }

    return {
      smsSent: false,
      error:
        otpData.description ||
        sendData.description ||
        `SMS gönderim hatası (${otpData.code || sendData.code || 'unknown'})`,
    };
  } catch (err) {
    console.error('[Cerilas SMS Error]:', err.message);
    return { smsSent: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
// POST /api/auth/send-otp
// Send 6-digit SMS OTP code via Cerilas SMS service
// Also pre-saves pending registration in users table so DB never loses user details
// ─────────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  try {
    const { phone, email, full_name, password, purpose = 'register' } = req.body || {};
    const digits = normalizeTurkishPhone(phone);

    if (!digits) {
      return res.status(400).json({
        error: 'Lütfen geçerli bir cep telefonu numarası girin (Örn: 05XX XXX XX XX).',
      });
    }

    let pendingUserId = null;

    if (purpose === 'register') {
      const cleanEmail = email ? String(email).trim().toLowerCase() : '';
      if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ error: 'Lütfen geçerli bir e-posta adresi girin.' });
      }

      const existingPhone = await pool.query(
        'SELECT * FROM users WHERE phone = $1 LIMIT 1',
        [digits]
      );

      if (existingPhone.rows.length > 0 && existingPhone.rows[0].phone_verified) {
        return res.status(400).json({
          error: 'Bu telefon numarası ile kayıtlı bir hesap zaten mevcut. Lütfen Giriş Yap sekmesinden giriş yapın.',
        });
      }

      if (cleanEmail) {
        const existingEmail = await pool.query(
          'SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1',
          [cleanEmail]
        );
        if (
          existingEmail.rows.length > 0 &&
          existingEmail.rows[0].phone &&
          existingEmail.rows[0].phone !== digits &&
          existingEmail.rows[0].phone_verified
        ) {
          return res.status(400).json({
            error: 'Bu e-posta adresi ile kayıtlı bir hesap zaten mevcut. Lütfen giriş yapın.',
          });
        }
      }

      // Pre-save or update pending user in PostgreSQL users table right away if credentials provided
      if (cleanEmail && password && String(password).length >= 6) {
        const passwordHash = hashPassword(String(password));
        const displayName = (full_name || '').trim() || cleanEmail.split('@')[0];

        if (existingPhone.rows.length > 0) {
          const updated = await pool.query(
            `UPDATE users SET
              full_name = $1,
              email = $2,
              password_hash = $3,
              last_login_at = NOW()
             WHERE id = $4
             RETURNING id`,
            [displayName, cleanEmail, passwordHash, existingPhone.rows[0].id]
          );
          pendingUserId = updated.rows[0]?.id || null;
        } else {
          const existingByEmail = await pool.query(
            'SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1',
            [cleanEmail]
          );
          if (existingByEmail.rows.length > 0) {
            const updated = await pool.query(
              `UPDATE users SET
                full_name = COALESCE(NULLIF($1, ''), full_name),
                phone = $2,
                password_hash = $3,
                last_login_at = NOW()
               WHERE id = $4
               RETURNING id`,
              [displayName, digits, passwordHash, existingByEmail.rows[0].id]
            );
            pendingUserId = updated.rows[0]?.id || null;
          } else {
            const inserted = await pool.query(
              `INSERT INTO users (
                full_name, email, phone, password_hash, phone_verified, auth_provider, created_at, last_login_at
              ) VALUES ($1, $2, $3, $4, FALSE, 'phone_email', NOW(), NOW())
              RETURNING id`,
              [displayName, cleanEmail, digits, passwordHash]
            );
            pendingUserId = inserted.rows[0]?.id || null;
          }
        }
      }
    } else if (purpose === 'login') {
      const existingPhone = await pool.query(
        'SELECT id FROM users WHERE phone = $1 LIMIT 1',
        [digits]
      );
      if (existingPhone.rows.length === 0) {
        return res.status(404).json({
          error: 'Bu telefon numarasına ait kayıtlı bir hesap bulunamadı. Lütfen önce kayıt olun.',
        });
      }
      pendingUserId = existingPhone.rows[0].id;
    }

    // Generate 6-digit numeric OTP code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate previous unverified codes for this phone
    await pool.query(
      'UPDATE phone_verification_codes SET verified = TRUE WHERE phone = $1 AND verified = FALSE',
      [digits]
    );

    // Save new code
    await pool.query(
      `INSERT INTO phone_verification_codes (user_id, phone, code, purpose, expires_at, verified)
       VALUES ($1, $2, $3, $4, $5, FALSE)`,
      [pendingUserId, digits, code, purpose, expiresAt]
    );

    const { smsSent, error: smsError } = await sendCerilasOtpSms(digits, code);
    console.log(`[SMS OTP] 0${digits} (${purpose}) -> Code: ${code}, Sent: ${smsSent}`);

    if (!smsSent) {
      return res.status(502).json({
        error: smsError || 'SMS doğrulama kodu gönderilemedi. Lütfen numarayı kontrol edip tekrar deneyin.',
      });
    }

    return res.json({
      success: true,
      smsSent: true,
      phone: `0${digits}`,
      cleanPhone: digits,
      expiresIn: 600,
      message: `Doğrulama kodu 0${digits} numaralı telefonunuza SMS olarak gönderildi.`,
    });
  } catch (err) {
    console.error('[Auth] send-otp error:', err);
    return res.status(500).json({ error: 'SMS gönderilirken sunucu hatası oluştu.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/register
// Verify SMS OTP and register/upsert user in PostgreSQL (no email verification required)
// ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { full_name, email, phone, password, otp_code } = req.body || {};

    if (!email || !phone || !password) {
      return res.status(400).json({
        error: 'E-posta, telefon numarası ve şifre alanları zorunludur.',
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Lütfen geçerli bir e-posta adresi girin.' });
    }

    const digits = normalizeTurkishPhone(phone);
    if (!digits) {
      return res.status(400).json({
        error: 'Lütfen geçerli bir cep telefonu numarası girin (05XX XXX XX XX).',
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        error: 'Şifreniz en az 6 karakter olmalıdır.',
      });
    }

    const cleanCode = String(otp_code || '').trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      return res.status(400).json({
        error: 'Lütfen telefonunuza gelen 6 haneli SMS doğrulama kodunu girin.',
      });
    }

    // Check OTP code (allow unverified OR recently verified code for idempotency on double-tap)
    const otpMatch = await pool.query(
      `SELECT id FROM phone_verification_codes
       WHERE phone = $1 AND code = $2 AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [digits, cleanCode]
    );

    if (otpMatch.rows.length === 0) {
      return res.status(400).json({
        error: 'SMS doğrulama kodu geçersiz veya süresi dolmuş. Lütfen tekrar kod isteyin.',
      });
    }

    const passwordHash = hashPassword(String(password));
    const displayName =
      (full_name || '').trim() || cleanEmail.split('@')[0];

    let savedUser = null;

    const existingPhone = await pool.query(
      'SELECT * FROM users WHERE phone = $1 LIMIT 1',
      [digits]
    );
    const existingEmail = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [cleanEmail]
    );

    const mergedExisting = await mergeUserAccounts(
      existingPhone.rows[0] || null,
      existingEmail.rows[0] || null
    );

    if (mergedExisting) {
      const updateRes = await pool.query(
        `UPDATE users SET
          full_name = COALESCE(NULLIF($1, ''), full_name),
          email = $2,
          phone = $3,
          password_hash = $4,
          phone_verified = TRUE,
          last_login_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [displayName, cleanEmail, digits, passwordHash, mergedExisting.id]
      );
      savedUser = updateRes.rows[0];
    } else {
      const insertRes = await pool.query(
        `INSERT INTO users (
          full_name, email, phone, password_hash, phone_verified, auth_provider, created_at, last_login_at
        ) VALUES ($1, $2, $3, $4, TRUE, 'phone_email', NOW(), NOW())
        RETURNING *`,
        [displayName, cleanEmail, digits, passwordHash]
      );
      savedUser = insertRes.rows[0];
    }

    // Mark OTP as verified and attach user_id
    await pool.query(
      'UPDATE phone_verification_codes SET verified = TRUE, user_id = $1 WHERE id = $2',
      [savedUser.id, otpMatch.rows[0].id]
    );

    const token = signToken({ id: savedUser.id, email: savedUser.email });
    console.log(`[Auth] User registered & verified in DB: ${savedUser.id} (${cleanEmail} / 0${digits})`);

    return res.status(201).json({
      success: true,
      token,
      user: formatUser(savedUser),
    });
  } catch (err) {
    console.error('[Auth] register error:', err);
    return res.status(500).json({ error: 'Kayıt işlemi sırasında bir hata oluştu.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/login
// Login with Email OR Phone + Password
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { identifier, email, phone, password } = req.body || {};
    const rawIdentifier = String(identifier || email || phone || '').trim();

    if (!rawIdentifier || !password) {
      return res.status(400).json({
        error: 'Lütfen e-posta veya telefon numaranızı ve şifrenizi girin.',
      });
    }

    let userResult;
    if (rawIdentifier.includes('@')) {
      const cleanEmail = rawIdentifier.toLowerCase();
      userResult = await pool.query(
        'SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1',
        [cleanEmail]
      );

      // Auto-provision Apple App Review demo account if not yet in DB
      if (
        userResult.rows.length === 0 &&
        (cleanEmail === 'apple@cerilas.com' || cleanEmail === 'demo@cerilas.com') &&
        String(password) === 'Gismo2026!'
      ) {
        const reviewerHash = hashPassword('Gismo2026!');
        userResult = await pool.query(
          `INSERT INTO users (
            full_name, email, phone_verified, password_hash, auth_provider, created_at, last_login_at
          ) VALUES ('Apple App Review', $1, TRUE, $2, 'phone_email', NOW(), NOW())
          RETURNING *`,
          [cleanEmail, reviewerHash]
        );
      }
    } else {
      const digits = normalizeTurkishPhone(rawIdentifier);
      if (!digits) {
        return res.status(400).json({
          error: 'Geçerli bir e-posta adresi veya cep telefonu numarası girin.',
        });
      }
      userResult = await pool.query(
        'SELECT * FROM users WHERE phone = $1 LIMIT 1',
        [digits]
      );
    }

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Bu e-posta veya telefon numarasına ait kayıtlı bir hesap bulunamadı. Lütfen önce kayıt olun.',
      });
    }

    const user = userResult.rows[0];
    if (!user.password_hash && user.google_id) {
      return res.status(400).json({
        error: 'Bu hesap Google/Apple ile oluşturulmuş. Lütfen sosyal giriş seçeneğini veya SMS Kodu ile girişi kullanın.',
      });
    }

    if (!verifyPassword(String(password), user.password_hash)) {
      return res.status(401).json({
        error: 'Şifre hatalı. Lütfen şifrenizi kontrol edin veya "SMS Kodu ile" giriş yapın.',
      });
    }

    const updatedRes = await pool.query(
      'UPDATE users SET last_login_at = NOW() WHERE id = $1 RETURNING *',
      [user.id]
    );
    const updatedUser = updatedRes.rows[0] || user;
    const token = signToken({ id: updatedUser.id, email: updatedUser.email });

    return res.json({
      success: true,
      token,
      user: formatUser(updatedUser),
    });
  } catch (err) {
    console.error('[Auth] login error:', err);
    return res.status(500).json({ error: 'Giriş yapılırken sunucu hatası oluştu.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/login-otp
// Login with Phone + 6-digit Cerilas SMS OTP code
// ─────────────────────────────────────────────
router.post('/login-otp', async (req, res) => {
  try {
    const { phone, otp_code } = req.body || {};
    const digits = normalizeTurkishPhone(phone);
    const cleanCode = String(otp_code || '').trim();

    if (!digits || !/^\d{6}$/.test(cleanCode)) {
      return res.status(400).json({
        error: 'Telefon numarası ve 6 haneli doğrulama kodu gereklidir.',
      });
    }

    const otpMatch = await pool.query(
      `SELECT id FROM phone_verification_codes
       WHERE phone = $1 AND code = $2 AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [digits, cleanCode]
    );

    if (otpMatch.rows.length === 0) {
      return res.status(400).json({
        error: 'SMS doğrulama kodu geçersiz veya süresi dolmuş.',
      });
    }

    const userRes = await pool.query(
      'SELECT * FROM users WHERE phone = $1 LIMIT 1',
      [digits]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({
        error: 'Bu telefon numarasına ait kullanıcı bulunamadı.',
      });
    }

    await pool.query(
      'UPDATE phone_verification_codes SET verified = TRUE, user_id = $1 WHERE id = $2',
      [userRes.rows[0].id, otpMatch.rows[0].id]
    );

    const updatedRes = await pool.query(
      'UPDATE users SET phone_verified = TRUE, last_login_at = NOW() WHERE id = $1 RETURNING *',
      [userRes.rows[0].id]
    );

    const user = updatedRes.rows[0];
    const token = signToken({ id: user.id, email: user.email });

    return res.json({
      success: true,
      token,
      user: formatUser(user),
    });
  } catch (err) {
    console.error('[Auth] login-otp error:', err);
    return res.status(500).json({ error: 'SMS ile giriş sırasında hata oluştu.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/google
// Sign in or Register with Google account & persist user in PostgreSQL
// ─────────────────────────────────────────────
router.post('/google', async (req, res) => {
  try {
    const { id_token, google_id, email, full_name, avatar_url } = req.body || {};

    let verifiedGoogleId = google_id ? String(google_id).trim() : '';
    let verifiedEmail = email ? String(email).trim().toLowerCase() : '';
    let verifiedName = full_name ? String(full_name).trim() : '';
    let verifiedAvatar = avatar_url ? String(avatar_url).trim() : '';

    // Verify Google id_token if provided
    if (id_token) {
      try {
        const verifyRes = await fetch(
          `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(id_token)}`
        );
        if (verifyRes.ok) {
          const payload = await verifyRes.json();
          if (payload && payload.sub) {
            verifiedGoogleId = payload.sub;
            verifiedEmail = (payload.email || verifiedEmail).toLowerCase().trim();
            verifiedName = payload.name || payload.given_name || verifiedName;
            verifiedAvatar = payload.picture || verifiedAvatar;
          }
        }
      } catch (verifyErr) {
        console.warn('[Google Auth] tokeninfo check fallback:', verifyErr.message);
      }
    }

    if (!verifiedGoogleId && !verifiedEmail) {
      return res.status(400).json({
        error: 'Google hesap bilgileri alınamadı.',
      });
    }

    let userByGoogle = null;
    let userByEmail = null;

    // 1. Find by google_id
    if (verifiedGoogleId) {
      const byGoogle = await pool.query(
        'SELECT * FROM users WHERE google_id = $1 LIMIT 1',
        [verifiedGoogleId]
      );
      if (byGoogle.rows.length > 0) {
        userByGoogle = byGoogle.rows[0];
      }
    }

    // 2. Find by email (auto-matches accounts registered with Phone + Email or Apple)
    if (verifiedEmail) {
      const byEmail = await pool.query(
        'SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1',
        [verifiedEmail]
      );
      if (byEmail.rows.length > 0) {
        userByEmail = byEmail.rows[0];
      }
    }

    // 3. Merge if both exist as separate rows, otherwise pick whichever exists
    let user = await mergeUserAccounts(userByEmail, userByGoogle);

    if (user) {
      const existingLegacyApple =
        user.google_id && String(user.google_id).startsWith('apple:')
          ? String(user.google_id).slice(6)
          : null;
      const updated = await pool.query(
        `UPDATE users SET
          google_id = COALESCE($1, google_id),
          apple_id = COALESCE(apple_id, $2),
          email = COALESCE(NULLIF(email, ''), $3),
          full_name = COALESCE(NULLIF(full_name, ''), $4),
          avatar_url = COALESCE(NULLIF($5, ''), avatar_url),
          last_login_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [
          verifiedGoogleId || null,
          existingLegacyApple,
          verifiedEmail || null,
          verifiedName || null,
          verifiedAvatar || null,
          user.id,
        ]
      );
      user = updated.rows[0];
      console.log(`[Google Auth] Account matched/merged & signed in: ${user.id} (${user.email} / phone=${user.phone || 'none'})`);
    } else {
      const displayName =
        verifiedName ||
        (verifiedEmail ? verifiedEmail.split('@')[0] : 'Google Kullanıcısı');
      const inserted = await pool.query(
        `INSERT INTO users (
          full_name, email, google_id, avatar_url, auth_provider, created_at, last_login_at
        ) VALUES ($1, $2, $3, $4, 'google', NOW(), NOW())
        RETURNING *`,
        [
          displayName,
          verifiedEmail || null,
          verifiedGoogleId || null,
          verifiedAvatar || null,
        ]
      );
      user = inserted.rows[0];
      console.log(`[Google Auth] New user created in DB: ${user.id} (${user.email})`);
    }

    const token = signToken({ id: user.id, email: user.email });
    return res.json({
      success: true,
      token,
      user: formatUser(user),
    });
  } catch (err) {
    console.error('[Auth] google auth error:', err);
    return res.status(500).json({ error: 'Google ile giriş yapılırken bir hata oluştu.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/apple
// Sign in or Register with Apple ID & auto-merge with Phone/Google accounts sharing the same email
// ─────────────────────────────────────────────
router.post('/apple', async (req, res) => {
  try {
    const { apple_id, identity_token, email, full_name } = req.body || {};
    let cleanAppleId = String(apple_id || '').trim();
    let tokenEmail = '';

    // Decode Apple identity_token JWT payload to always extract email & sub even on 2nd+ logins
    if (identity_token && typeof identity_token === 'string') {
      const parts = identity_token.split('.');
      if (parts.length >= 2) {
        try {
          const payload = JSON.parse(base64UrlDecode(parts[1]));
          if (payload) {
            if (!cleanAppleId && payload.sub) {
              cleanAppleId = String(payload.sub).trim();
            }
            if (payload.email) {
              tokenEmail = String(payload.email).trim().toLowerCase();
            }
          }
        } catch (decodeErr) {
          console.warn('[Apple Auth] identity_token decode warning:', decodeErr.message);
        }
      }
    }

    const rawBodyEmail = email ? String(email).trim().toLowerCase() : '';
    const realEmail = rawBodyEmail || tokenEmail;
    const cleanEmail =
      realEmail ||
      (cleanAppleId
        ? `${cleanAppleId.slice(0, 24).replace(/[^a-zA-Z0-9._-]/g, '')}@privaterelay.appleid.com`
        : '');
    const cleanName = String(full_name || '').trim();

    if (!cleanAppleId && !cleanEmail) {
      return res.status(400).json({ error: 'Apple hesap bilgileri alınamadı.' });
    }

    let userByApple = null;
    let userByEmail = null;

    // 1. Find by apple_id (or legacy google_id = 'apple:...')
    if (cleanAppleId) {
      const byApple = await pool.query(
        'SELECT * FROM users WHERE apple_id = $1 OR google_id = $2 LIMIT 1',
        [cleanAppleId, `apple:${cleanAppleId}`]
      );
      if (byApple.rows.length > 0) {
        userByApple = byApple.rows[0];
      }
    }

    // 2. Find by email (auto-matches accounts registered with Phone + Email or Google)
    if (realEmail) {
      const byEmail = await pool.query(
        'SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1',
        [realEmail]
      );
      if (byEmail.rows.length > 0) {
        userByEmail = byEmail.rows[0];
      }
    }

    // 3. Merge if both exist as separate rows, otherwise pick whichever exists
    let user = await mergeUserAccounts(userByEmail, userByApple);

    if (user) {
      const updated = await pool.query(
        `UPDATE users SET
          apple_id = COALESCE($1, apple_id),
          email = CASE
            WHEN email IS NULL OR email = '' OR email LIKE '%@privaterelay.appleid.com'
            THEN COALESCE(NULLIF($2, ''), email)
            ELSE email
          END,
          full_name = COALESCE(NULLIF(full_name, ''), NULLIF($3, ''), 'Apple Kullanıcısı'),
          last_login_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [cleanAppleId || null, realEmail || null, cleanName, user.id]
      );
      user = updated.rows[0];
      console.log(`[Apple Auth] Account matched/merged & signed in: ${user.id} (${user.email} / phone=${user.phone || 'none'})`);
    } else {
      const inserted = await pool.query(
        `INSERT INTO users (
          full_name, email, apple_id, auth_provider, phone_verified, created_at, last_login_at
        ) VALUES ($1, $2, $3, 'apple', FALSE, NOW(), NOW())
        RETURNING *`,
        [
          cleanName || 'Apple Kullanıcısı',
          cleanEmail || null,
          cleanAppleId || null,
        ]
      );
      user = inserted.rows[0];
      console.log(`[Apple Auth] New user created in DB: ${user.id} (${user.email})`);
    }

    const token = signToken({ id: user.id, email: user.email });
    return res.json({
      success: true,
      token,
      user: formatUser(user),
    });
  } catch (err) {
    console.error('[Auth] apple auth error:', err);
    return res.status(500).json({ error: 'Apple ile giriş yapılırken bir hata oluştu.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/auth/me
// Get current authenticated user profile
// ─────────────────────────────────────────────
router.get('/me', requireUserAuth, async (req, res) => {
  try {
    let result = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [
      req.user.id,
    ]);
    if (result.rows.length === 0 && req.user.email) {
      result = await pool.query(
        'SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [req.user.email]
      );
    }
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Kullanıcı bulunamadı.' });
    }
    return res.json({
      authenticated: true,
      user: formatUser(result.rows[0]),
    });
  } catch (err) {
    console.error('[Auth] me error:', err);
    return res.status(500).json({ error: 'Kullanıcı bilgileri alınamadı.' });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/auth/account
// Delete current authenticated user's account
// ─────────────────────────────────────────────
router.delete('/account', requireUserAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    return res.json({ success: true, message: 'Hesabınız silindi.' });
  } catch (err) {
    console.error('[Auth] delete account error:', err);
    return res.status(500).json({ error: 'Hesap silinemedi.' });
  }
});

module.exports = router;
