/* ============================================================
   auth.html — вход / регистрация на отдельной странице.
   Логика та же, что раньше была в модалке index.html:
   PBKDF2-хеши, защита от перебора, проверка банов.
   Успех → возврат на index.html.
============================================================ */

const USERS_KEY = 'mf_users';
const SESSION_KEY = 'mf_session';
const PBKDF2_ITERATIONS = 150000;

const getUsers = () => JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
const saveUsers = (users) => localStorage.setItem(USERS_KEY, JSON.stringify(users));

// Хеширование пароля — как в script.js
function bytesToB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
async function pbkdf2(password, saltB64, iterations) {
    const enc = new TextEncoder();
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, keyMat, 256
    );
    return bytesToB64(bits);
}
async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = bytesToB64(salt);
    const hash = await pbkdf2(password, saltB64, PBKDF2_ITERATIONS);
    return { salt: saltB64, hash, iterations: PBKDF2_ITERATIONS };
}

// Активен ли бан (timed истекает, permanent/publish — нет)
function banActive(u) {
    const b = u && u.ban;
    if (!b) return null;
    if (b.type === 'timed' && (!b.until || b.until <= Date.now())) return null;
    return b;
}

// ---- Регистрация / вход ----

async function register(user, pass) {
    const users = getUsers();
    if (users.some(u => u.user.toLowerCase() === user.toLowerCase())) {
        return { error: t('toast.user_taken') };
    }
    const { salt, hash, iterations } = await hashPassword(pass);
    users.push({
        user, salt, pass: hash, iterations, joined: Date.now(),
        profile: { name: '', bio: '', avatar: '', color: '' },
    });
    saveUsers(users);
    localStorage.setItem(SESSION_KEY, user);
    return { ok: true };
}

async function login(user, pass) {
    const found = getUsers().find(u => u.user.toLowerCase() === user.toLowerCase());
    if (!found) return { error: t('toast.wrong_cred') };

    // Защита от перебора: 5 неудачных попыток → блокировка на 60 секунд
    const attemptsKey = 'mf_attempts_' + user.toLowerCase();
    const attempts = JSON.parse(localStorage.getItem(attemptsKey) || '{"n":0,"until":0}');
    const now = Date.now();
    if (attempts.until > now) {
        return { error: t('toast.locked', { s: Math.ceil((attempts.until - now) / 1000) }) };
    }

    let ok = false;
    if (found.salt) {
        ok = found.pass === await pbkdf2(pass, found.salt, found.iterations || PBKDF2_ITERATIONS);
    } else {
        // миграция старого аккаунта (незашифрованный «хеш» из прежней версии)
        const legacy = btoa(unescape(encodeURIComponent('mf:' + pass)));
        if (found.pass === legacy) {
            const { salt, hash, iterations } = await hashPassword(pass);
            found.salt = salt; found.pass = hash; found.iterations = iterations;
            saveUsers(getUsers().map(u => u.user === found.user ? found : u));
            ok = true;
        }
    }

    if (!ok) {
        attempts.n = (attempts.n || 0) + 1;
        if (attempts.n >= 5) {
            attempts.until = now + 60000;
            attempts.n = 0;
        }
        localStorage.setItem(attemptsKey, JSON.stringify(attempts));
        return { error: t('toast.wrong_cred') };
    }

    localStorage.removeItem(attemptsKey);

    // Забаненный (timed/permanent) не может войти
    const ban = banActive(found);
    if (ban && ban.type !== 'publish') {
        return {
            error: ban.type === 'permanent'
                ? t('ban.login_perm', { r: ban.reason || '—' })
                : t('ban.login_until', { date: new Date(ban.until).toLocaleDateString(), r: ban.reason || '—' }),
        };
    }

    localStorage.setItem(SESSION_KEY, found.user);
    return { ok: true };
}

// ================= Интерфейс страницы =================

let toastTimer = null;
function toast(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const loginForm = document.getElementById('auth-login-form');
const regForm = document.getElementById('auth-reg-form');

function switchAuth(mode) {
    loginForm.classList.toggle('hidden', mode !== 'login');
    regForm.classList.toggle('hidden', mode !== 'register');
    document.querySelectorAll('[data-auth]').forEach(b =>
        b.classList.toggle('active', b.dataset.auth === mode)
    );
    document.getElementById('auth-title').textContent =
        mode === 'login' ? t('auth.title_login') : t('auth.title_register');
}

document.querySelectorAll('[data-auth]').forEach(b =>
    b.addEventListener('click', () => switchAuth(b.dataset.auth))
);

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await login(
        document.getElementById('login-user').value.trim(),
        document.getElementById('login-pass').value
    );
    if (res.error) return toast(res.error);
    toast(t('toast.welcome_back', { name: document.getElementById('login-user').value.trim() }));
    location.href = 'index.html';
});

regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = document.getElementById('reg-user').value.trim();
    const pass = document.getElementById('reg-pass').value;
    const pass2 = document.getElementById('reg-pass2').value;
    if (user.length < 3 || user.length > 24) return toast(t('toast.short_user'));
    if (pass.length < 8) return toast(t('toast.short_pass'));
    if (pass !== pass2) return toast(t('toast.pass_mismatch'));
    const res = await register(user, pass);
    if (res.error) return toast(res.error);
    toast(t('toast.created', { name: user }));
    location.href = 'index.html';
});

// ================= Запуск =================

applyI18n();

// Если уже вошёл — незачем здесь быть
if (localStorage.getItem(SESSION_KEY)) {
    location.href = 'index.html';
} else {
    // ?mode=register — сразу открытая вкладка регистрации (ссылки «Sign up»)
    const params = new URLSearchParams(location.search);
    switchAuth(params.get('mode') === 'register' ? 'register' : 'login');
}
