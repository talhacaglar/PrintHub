// ============================================
// PrintHub — Kimlik Doğrulama & RBAC (auth.js)
// ISO 27001: A.5.15 Erişim kontrolü, A.5.17/A.8.5 Kimlik doğrulama,
//            A.8.15 Loglama (denetim).
// ============================================

const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, audit } = require('./db');

// Rol hiyerarşisi — büyük sayı daha çok yetki
const ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 };

// bcrypt maliyet faktörü (OWASP önerisi >= 10; 12 masaüstü için makul)
const BCRYPT_ROUNDS = 12;

// --- Brute-force koruması (ISO A.8.5) ---
// Kullanıcı adı bazlı başarısız giriş sayacı; eşik aşılırsa geçici kilit.
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 dakika
const loginAttempts = new Map(); // username -> { count, lockedUntil }

function checkLockout(username) {
    const rec = loginAttempts.get(username);
    if (!rec) return 0;
    if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
        return Math.ceil((rec.lockedUntil - Date.now()) / 1000); // kalan saniye
    }
    if (rec.lockedUntil && rec.lockedUntil <= Date.now()) loginAttempts.delete(username);
    return 0;
}

function recordLoginFailure(username) {
    const rec = loginAttempts.get(username) || { count: 0, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= MAX_LOGIN_ATTEMPTS) {
        rec.lockedUntil = Date.now() + LOCKOUT_MS;
        rec.count = 0; // kilit süresi dolunca temiz sayfa
    }
    loginAttempts.set(username, rec);
    return rec.lockedUntil > Date.now();
}

function clearLoginFailures(username) {
    loginAttempts.delete(username);
}

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString();
}

// Oturum middleware'i (bellekte store — tek kullanıcılı masaüstü uygulaması için yeterli)
// Oturum sırrı: env verilmemişse her açılışta rastgele üretilir.
// Store bellekte olduğundan yeniden başlatmada oturumlar zaten düşer;
// sabit/tahmin edilebilir sır kullanmaktan güvenlidir.
const SESSION_SECRET = process.env.PRINTHUB_SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 } // 8 saat
});

// ============================================
// BEARER TOKEN KATMANI (ISO A.5.17 / A.8.5)
// Girişte rastgele 256-bit jeton üretilir; istemciye yalnızca bir kez
// ham hali verilir, veritabanında SHA-256 özeti saklanır. Jeton süreli
// ve iptal edilebilirdir (çıkışta / parola değişiminde silinir).
// ============================================
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 saat — oturum çerezi ile aynı

function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Süresi dolmuş jetonları temizle (her doğrulamada ucuz bir bakım)
function purgeExpiredTokens() {
    db.prepare("DELETE FROM auth_tokens WHERE expires_at <= datetime('now')").run();
}

function issueToken(userId, ip) {
    const raw = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, expires_at, ip)
                VALUES (?, ?, ?, ?)`).run(hashToken(raw), userId, expiresAt, ip || '');
    return { token: raw, expiresAt };
}

function revokeToken(raw) {
    if (!raw) return false;
    return db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(hashToken(raw)).changes > 0;
}

function revokeAllTokensForUser(userId) {
    return db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(userId).changes;
}

// Authorization: Bearer <token> başlığından ham jetonu çıkarır
function extractBearer(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1].trim() : null;
}

// Jetonu doğrular; geçerliyse kullanıcıyı döndürür, aksi halde null.
function resolveTokenUser(req) {
    const raw = extractBearer(req);
    if (!raw) return null;
    purgeExpiredTokens();
    const row = db.prepare(`
        SELECT t.id AS token_id, u.id, u.username, u.role, u.must_change_password
        FROM auth_tokens t JOIN app_users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.expires_at > datetime('now')
    `).get(hashToken(raw));
    if (!row) return null;
    db.prepare("UPDATE auth_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.token_id);
    return {
        id: row.id, username: row.username, role: row.role,
        mustChangePassword: !!row.must_change_password
    };
}

// Her istekte önce Bearer jetonu, yoksa oturum çerezi değerlendirilir.
// Böylece mevcut çerez tabanlı akış bozulmadan token desteği eklenir.
function authenticate(req, res, next) {
    if (!req.authUser) {
        const tokenUser = resolveTokenUser(req);
        if (tokenUser) req.authUser = tokenUser;
        else if (req.session && req.session.user) req.authUser = req.session.user;
    }
    next();
}

// --- Middleware'ler ---
function requireAuth(req, res, next) {
    if (currentUser(req)) return next();
    return res.status(401).json({ error: 'Oturum açılmamış.' });
}

function requireRole(...roles) {
    const minAllowed = Math.min(...roles.map(r => ROLE_LEVEL[r] || 99));
    return (req, res, next) => {
        const user = currentUser(req);
        if (!user) return res.status(401).json({ error: 'Oturum açılmamış.' });
        if ((ROLE_LEVEL[user.role] || 0) >= minAllowed) return next();
        audit({
            actor: user.username, action: 'access_denied', entity: 'endpoint',
            entity_id: req.path, detail: `Rol '${user.role}' yetersiz`, ip: clientIp(req)
        });
        return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
    };
}

// Geçerli kullanıcı: önce Bearer jetonuyla çözülen kimlik, yoksa oturum çerezi.
function currentUser(req) {
    if (req.authUser) return req.authUser;
    const tokenUser = resolveTokenUser(req);
    if (tokenUser) { req.authUser = tokenUser; return tokenUser; }
    return (req.session && req.session.user) || null;
}

// --- Rotalar ---
function attachAuthRoutes(app) {
    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body || {};
        const uname = String(username || '');
        const ip = clientIp(req);

        // Brute-force kilidi kontrolü
        const lockRemain = checkLockout(uname);
        if (lockRemain > 0) {
            audit({ actor: uname || '?', action: 'login_locked', entity: 'auth', detail: `Hesap kilitli (${lockRemain}s)`, ip });
            return res.status(429).json({ error: `Çok fazla başarısız deneme. ${Math.ceil(lockRemain / 60)} dakika sonra tekrar deneyin.` });
        }

        const row = db.prepare('SELECT * FROM app_users WHERE username = ?').get(uname);
        const ok = row ? await bcrypt.compare(password || '', row.password_hash) : false;
        if (!ok) {
            const locked = recordLoginFailure(uname);
            audit({ actor: uname || '?', action: 'login_failed', entity: 'auth', detail: locked ? 'Hatalı kimlik bilgisi — hesap geçici kilitlendi' : 'Hatalı kimlik bilgisi', ip });
            return res.status(401).json({ error: 'Kullanıcı adı veya parola hatalı.' });
        }

        clearLoginFailures(uname);
        req.session.user = { id: row.id, username: row.username, role: row.role, mustChangePassword: !!row.must_change_password };
        // Bearer jetonu üret — istemci sonraki isteklerde Authorization başlığıyla gönderir
        const { token, expiresAt } = issueToken(row.id, ip);
        audit({ actor: row.username, action: 'login', entity: 'auth', detail: 'jeton verildi', ip });
        res.json({
            user: req.session.user,
            token,
            expiresAt,
            mustChangePassword: !!row.must_change_password
        });
    });

    app.post('/api/logout', (req, res) => {
        const user = currentUser(req);
        // Kullanılan jetonu iptal et (yalnız bu oturum düşer)
        revokeToken(extractBearer(req));
        if (user) audit({ actor: user.username, action: 'logout', entity: 'auth', ip: clientIp(req) });
        if (req.session) req.session.destroy(() => res.json({ ok: true }));
        else res.json({ ok: true });
    });

    app.get('/api/me', (req, res) => {
        const user = currentUser(req);
        if (!user) return res.status(401).json({ error: 'Oturum açılmamış.' });
        res.json({ user });
    });

    // Parola değiştirme (kendi hesabı)
    app.post('/api/change-password', requireAuth, async (req, res) => {
        const { currentPassword, newPassword } = req.body || {};
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: 'Yeni parola en az 6 karakter olmalı.' });
        }
        const me = currentUser(req);
        const row = db.prepare('SELECT * FROM app_users WHERE id = ?').get(me.id);
        if (!(await bcrypt.compare(currentPassword || '', row.password_hash))) {
            return res.status(401).json({ error: 'Mevcut parola hatalı.' });
        }
        const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        db.prepare('UPDATE app_users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, me.id);
        if (req.session && req.session.user) req.session.user.mustChangePassword = false; // kapı middleware'i için bayrağı temizle
        if (req.authUser) req.authUser.mustChangePassword = false;

        // Parola değişti → eski jetonların tamamı iptal, yerine tek yeni jeton.
        // Çalınmış bir jeton parola değişimiyle geçersiz kalır (ISO A.8.5).
        revokeAllTokensForUser(me.id);
        const { token, expiresAt } = issueToken(me.id, clientIp(req));

        audit({ actor: me.username, action: 'change_password', entity: 'user', entity_id: me.id, detail: 'jetonlar yenilendi', ip: clientIp(req) });
        res.json({ ok: true, token, expiresAt });
    });

    // --- Kullanıcı yönetimi (yalnız admin) ---
    app.get('/api/users', requireRole('admin'), (req, res) => {
        const users = db.prepare('SELECT id, username, role, must_change_password, created_at FROM app_users ORDER BY id').all();
        res.json({ users });
    });

    app.post('/api/users', requireRole('admin'), async (req, res) => {
        const { username, password, role } = req.body || {};
        if (!username || !password || !['admin', 'operator', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Geçersiz kullanıcı bilgisi.' });
        }
        try {
            const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
            const info = db.prepare(`INSERT INTO app_users (username, password_hash, role, must_change_password)
                                     VALUES (?, ?, ?, 1)`).run(username, hash, role);
            audit({ actor: currentUser(req).username, action: 'create', entity: 'user', entity_id: info.lastInsertRowid, detail: `${username} (${role})`, ip: clientIp(req) });
            res.json({ id: info.lastInsertRowid });
        } catch (e) {
            res.status(409).json({ error: 'Bu kullanıcı adı zaten var.' });
        }
    });

    app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
        const { role, password } = req.body || {};
        const id = parseInt(req.params.id);
        const row = db.prepare('SELECT * FROM app_users WHERE id = ?').get(id);
        if (!row) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

        if (role && ['admin', 'operator', 'viewer'].includes(role)) {
            db.prepare('UPDATE app_users SET role = ? WHERE id = ?').run(role, id);
        }
        if (password) {
            const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
            db.prepare('UPDATE app_users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, id);
            revokeAllTokensForUser(id); // parola sıfırlandı → açık oturumları düşür
        }
        if (role && role !== row.role) revokeAllTokensForUser(id); // rol değişti → yeniden giriş şart
        audit({ actor: currentUser(req).username, action: 'update', entity: 'user', entity_id: id, ip: clientIp(req) });
        res.json({ ok: true });
    });

    app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
        const id = parseInt(req.params.id);
        const me = currentUser(req);
        if (id === me.id) return res.status(400).json({ error: 'Kendinizi silemezsiniz.' });
        const count = db.prepare("SELECT COUNT(*) AS c FROM app_users WHERE role = 'admin'").get().c;
        const target = db.prepare('SELECT role FROM app_users WHERE id = ?').get(id);
        if (target && target.role === 'admin' && count <= 1) {
            return res.status(400).json({ error: 'Son yönetici silinemez.' });
        }
        revokeAllTokensForUser(id); // silinen kullanıcının açık jetonları geçersiz
        db.prepare('DELETE FROM app_users WHERE id = ?').run(id);
        audit({ actor: me.username, action: 'delete', entity: 'user', entity_id: id, ip: clientIp(req) });
        res.json({ ok: true });
    });
}

module.exports = {
    sessionMiddleware,
    authenticate,
    requireAuth,
    requireRole,
    currentUser,
    clientIp,
    attachAuthRoutes,
    // Jeton yardımcıları (test ve dahili kullanım)
    issueToken,
    revokeToken,
    revokeAllTokensForUser,
    resolveTokenUser,
    extractBearer,
    hashToken,
    TOKEN_TTL_MS,
};
