// ============================================
// PrintHub — Kimlik Doğrulama & RBAC (auth.js)
// ISO 27001: A.5.15 Erişim kontrolü, A.5.17/A.8.5 Kimlik doğrulama,
//            A.8.15 Loglama (denetim).
// ============================================

const session = require('express-session');
const bcrypt = require('bcryptjs');
const { db, audit } = require('./db');

// Rol hiyerarşisi — büyük sayı daha çok yetki
const ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 };

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString();
}

// Oturum middleware'i (bellekte store — tek kullanıcılı masaüstü uygulaması için yeterli)
const sessionMiddleware = session({
    secret: process.env.PRINTHUB_SESSION_SECRET || 'printhub-local-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 } // 8 saat
});

// --- Middleware'ler ---
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.status(401).json({ error: 'Oturum açılmamış.' });
}

function requireRole(...roles) {
    const minAllowed = Math.min(...roles.map(r => ROLE_LEVEL[r] || 99));
    return (req, res, next) => {
        const user = req.session && req.session.user;
        if (!user) return res.status(401).json({ error: 'Oturum açılmamış.' });
        if ((ROLE_LEVEL[user.role] || 0) >= minAllowed) return next();
        audit({
            actor: user.username, action: 'access_denied', entity: 'endpoint',
            entity_id: req.path, detail: `Rol '${user.role}' yetersiz`, ip: clientIp(req)
        });
        return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
    };
}

function currentUser(req) {
    return (req.session && req.session.user) || null;
}

// --- Rotalar ---
function attachAuthRoutes(app) {
    app.post('/api/login', (req, res) => {
        const { username, password } = req.body || {};
        const row = db.prepare('SELECT * FROM app_users WHERE username = ?').get(username || '');
        const ip = clientIp(req);

        if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
            audit({ actor: username || '?', action: 'login_failed', entity: 'auth', detail: 'Hatalı kimlik bilgisi', ip });
            return res.status(401).json({ error: 'Kullanıcı adı veya parola hatalı.' });
        }

        req.session.user = { id: row.id, username: row.username, role: row.role };
        audit({ actor: row.username, action: 'login', entity: 'auth', ip });
        res.json({
            user: req.session.user,
            mustChangePassword: !!row.must_change_password
        });
    });

    app.post('/api/logout', (req, res) => {
        const user = currentUser(req);
        if (user) audit({ actor: user.username, action: 'logout', entity: 'auth', ip: clientIp(req) });
        req.session.destroy(() => res.json({ ok: true }));
    });

    app.get('/api/me', (req, res) => {
        const user = currentUser(req);
        if (!user) return res.status(401).json({ error: 'Oturum açılmamış.' });
        res.json({ user });
    });

    // Parola değiştirme (kendi hesabı)
    app.post('/api/change-password', requireAuth, (req, res) => {
        const { currentPassword, newPassword } = req.body || {};
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: 'Yeni parola en az 6 karakter olmalı.' });
        }
        const me = currentUser(req);
        const row = db.prepare('SELECT * FROM app_users WHERE id = ?').get(me.id);
        if (!bcrypt.compareSync(currentPassword || '', row.password_hash)) {
            return res.status(401).json({ error: 'Mevcut parola hatalı.' });
        }
        const hash = bcrypt.hashSync(newPassword, 10);
        db.prepare('UPDATE app_users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, me.id);
        audit({ actor: me.username, action: 'change_password', entity: 'user', entity_id: me.id, ip: clientIp(req) });
        res.json({ ok: true });
    });

    // --- Kullanıcı yönetimi (yalnız admin) ---
    app.get('/api/users', requireRole('admin'), (req, res) => {
        const users = db.prepare('SELECT id, username, role, must_change_password, created_at FROM app_users ORDER BY id').all();
        res.json({ users });
    });

    app.post('/api/users', requireRole('admin'), (req, res) => {
        const { username, password, role } = req.body || {};
        if (!username || !password || !['admin', 'operator', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Geçersiz kullanıcı bilgisi.' });
        }
        try {
            const hash = bcrypt.hashSync(password, 10);
            const info = db.prepare(`INSERT INTO app_users (username, password_hash, role, must_change_password)
                                     VALUES (?, ?, ?, 1)`).run(username, hash, role);
            audit({ actor: currentUser(req).username, action: 'create', entity: 'user', entity_id: info.lastInsertRowid, detail: `${username} (${role})`, ip: clientIp(req) });
            res.json({ id: info.lastInsertRowid });
        } catch (e) {
            res.status(409).json({ error: 'Bu kullanıcı adı zaten var.' });
        }
    });

    app.put('/api/users/:id', requireRole('admin'), (req, res) => {
        const { role, password } = req.body || {};
        const id = parseInt(req.params.id);
        const row = db.prepare('SELECT * FROM app_users WHERE id = ?').get(id);
        if (!row) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

        if (role && ['admin', 'operator', 'viewer'].includes(role)) {
            db.prepare('UPDATE app_users SET role = ? WHERE id = ?').run(role, id);
        }
        if (password) {
            const hash = bcrypt.hashSync(password, 10);
            db.prepare('UPDATE app_users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, id);
        }
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
        db.prepare('DELETE FROM app_users WHERE id = ?').run(id);
        audit({ actor: me.username, action: 'delete', entity: 'user', entity_id: id, ip: clientIp(req) });
        res.json({ ok: true });
    });
}

module.exports = {
    sessionMiddleware,
    requireAuth,
    requireRole,
    currentUser,
    clientIp,
    attachAuthRoutes,
};
