/* ============================================================
   MeshFab — мини-аналог Sketchfab.
   Всё работает локально в браузере, без сервера:
   - аккаунты: localStorage, пароли — PBKDF2-SHA256 (150k итераций,
     уникальная соль на аккаунт), как на «настоящих» сайтах
   - модели: IndexedDB (сами .glb/.gltf файлы хранятся как blob)
   - просмотрщик модели: three.js (см. viewer.js)
   - интерфейс: 4 языка (i18n.js)
============================================================ */

// ================= Хранилище моделей (IndexedDB) =================

let db = null;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('meshfab', 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore('models', { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function dbGetAll() {
    return new Promise((resolve) => {
        const req = db.transaction('models').objectStore('models').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve([]);
    });
}

function dbPut(model) {
    return new Promise((resolve) => {
        const req = db.transaction('models', 'readwrite').objectStore('models').put(model);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
}

function dbDelete(id) {
    return new Promise((resolve) => {
        const req = db.transaction('models', 'readwrite').objectStore('models').delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
    });
}

// Локальные blob-ссылки на выложенные модели (создаём один раз и кэшируем)
const objectUrls = new Map();

function srcFor(model) {
    if (model.blob) {
        if (!objectUrls.has(model.id)) {
            objectUrls.set(model.id, URL.createObjectURL(model.blob));
        }
        return objectUrls.get(model.id);
    }
    return model.src; // демо-модели: просто ссылка
}

// Человекочитаемый размер файла
function fileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ================= Безопасность паролей (PBKDF2-SHA256) =================
// Как на «настоящих» сайтах: пароль НИКОГДА не хранится — только хеш,
// полученный через 150 000 итераций PBKDF2 с уникальной солью на аккаунт.

const PBKDF2_ITERATIONS = 150000;

function bytesToB64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function pbkdf2(password, saltB64, iterations) {
    const enc = new TextEncoder();
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        keyMat, 256
    );
    return bytesToB64(bits);
}

async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = bytesToB64(salt);
    const hash = await pbkdf2(password, saltB64, PBKDF2_ITERATIONS);
    return { salt: saltB64, hash, iterations: PBKDF2_ITERATIONS };
}

// ================= Аккаунты (localStorage, без мейла) =================

const USERS_KEY = 'mf_users';
const SESSION_KEY = 'mf_session';

const getUsers = () => JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
const saveUsers = (users) => localStorage.setItem(USERS_KEY, JSON.stringify(users));

function currentUser() {
    const name = localStorage.getItem(SESSION_KEY);
    return name ? getUsers().find(u => u.user === name) || null : null;
}

const isAdmin = () => { const u = currentUser(); return !!(u && u.admin); };

// Отображаемое имя автора (кастомизация профиля)
function authorName(username) {
    const u = getUsers().find(x => x.user.toLowerCase() === username.toLowerCase());
    return (u && u.profile && u.profile.name) || username;
}

// ---- Регистрация / вход (асинхронные из-за PBKDF2) ----

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
        // нормальный путь: PBKDF2-хеш
        ok = found.pass === await pbkdf2(pass, found.salt, found.iterations || PBKDF2_ITERATIONS);
    } else {
        // миграция старого аккаунта (незашифрованный «хеш» из прежней версии):
        // если пароль подходит — сразу пересоздаём с PBKDF2
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
            attempts.until = now + 60000; // блок на минуту
            attempts.n = 0;
        }
        localStorage.setItem(attemptsKey, JSON.stringify(attempts));
        return { error: t('toast.wrong_cred') };
    }

    localStorage.removeItem(attemptsKey);
    localStorage.setItem(SESSION_KEY, found.user);
    return { ok: true };
}

function logout() {
    localStorage.removeItem(SESSION_KEY);
    renderAuthArea();
    showView('home');
    toast(t('toast.logged_out'));
}

// Лайки текущего пользователя (список id моделей)
const likesKey = (user) => 'mf_likes_' + user.toLowerCase();
const getMyLikes = () => {
    const u = currentUser();
    return u ? JSON.parse(localStorage.getItem(likesKey(u.user)) || '[]') : [];
};
const saveMyLikes = (arr) => {
    const u = currentUser();
    if (u) localStorage.setItem(likesKey(u.user), JSON.stringify(arr));
};

// ================= Экранирование и уведомления =================

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

let toastTimer = null;
function toast(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ================= Простой роутер (главная / модель / профиль) =================

function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    window.scrollTo(0, 0);
}

// Дата в локали текущего языка
function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(DATE_LOCALES[LANG] || 'en-US');
}

// ================= Шапка: вход / аккаунт =================

function renderAuthArea() {
    const area = document.getElementById('auth-area');
    const u = currentUser();
    if (u) {
        area.innerHTML = `
            <button class="btn user-chip" id="user-chip" type="button" title="My profile">${esc(authorName(u.user))}</button>`;
        document.getElementById('user-chip').addEventListener('click', () => openProfile(u.user));
    } else {
        area.innerHTML = `
            <button class="btn" id="login-open" data-i18n="nav.signin" type="button">Sign in</button>
            <button class="btn primary" id="signup-open" data-i18n="nav.signup" type="button">Sign up</button>`;
        document.getElementById('login-open').addEventListener('click', () => openAuthModal('login'));
        document.getElementById('signup-open').addEventListener('click', () => openAuthModal('register'));
        applyI18n(area);
    }
}

// ================= Модалка входа / регистрации =================

const authModal = document.getElementById('auth-modal');
const loginForm = document.getElementById('auth-login-form');
const regForm = document.getElementById('auth-reg-form');

function openAuthModal(mode) {
    switchAuth(mode || 'login');
    authModal.classList.remove('hidden');
}

function switchAuth(mode) {
    loginForm.classList.toggle('hidden', mode !== 'login');
    regForm.classList.toggle('hidden', mode !== 'register');
    document.querySelectorAll('#auth-modal [data-auth]').forEach(b =>
        b.classList.toggle('active', b.dataset.auth === mode)
    );
    document.getElementById('auth-title').textContent =
        mode === 'login' ? t('auth.title_login') : t('auth.title_register');
}

document.querySelectorAll('#auth-modal [data-auth]').forEach(b =>
    b.addEventListener('click', () => switchAuth(b.dataset.auth))
);

document.getElementById('auth-close').addEventListener('click', () => authModal.classList.add('hidden'));
authModal.addEventListener('click', (e) => {
    if (e.target === authModal) authModal.classList.add('hidden');
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await login(
        document.getElementById('login-user').value.trim(),
        document.getElementById('login-pass').value
    );
    if (res.error) return toast(res.error);
    authModal.classList.add('hidden');
    renderAuthArea();
    toast(t('toast.welcome_back', { name: authorName(currentUser().user) }));
    loginForm.reset();
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
    authModal.classList.add('hidden');
    renderAuthArea();
    toast(t('toast.created', { name: user }));
    regForm.reset();
});

// ================= Дефолты просмотрщика из Sttng =================

const VIEWER_DEFAULTS_KEY = 'mf_viewer_defaults';
function viewerDefaults() {
    return JSON.parse(localStorage.getItem(VIEWER_DEFAULTS_KEY) || '{}');
}

// ================= Главная: лента моделей + поиск =================

let searchQuery = '';
let categoryFilter = '';

async function renderHome() {
    const all = await dbGetAll();
    const me = currentUser();
    const q = searchQuery.trim().toLowerCase();

    const list = all
        // приватные модели видит только их автор (и админ)
        .filter(m => m.public !== false || (me && (me.user === m.author || me.admin)))
        .filter(m => !categoryFilter || m.category === categoryFilter)
        .filter(m => {
            if (!q) return true;
            const tags = (m.tags || []).join(' ').toLowerCase();
            return m.name.toLowerCase().includes(q)
                || authorName(m.author).toLowerCase().includes(q)
                || m.author.toLowerCase().includes(q)
                || (m.category || '').toLowerCase().includes(q)
                || tags.includes(q);
        })
        .sort((a, b) => b.views - a.views);

    document.getElementById('grid-empty').classList.toggle('hidden', list.length > 0);
    renderGrid(document.getElementById('models-grid'), list);
}

// Рисует сетку карточек (используется на главной и в профиле)
function renderGrid(gridEl, models) {
    gridEl.innerHTML = '';

    models.forEach(m => {
        const card = document.createElement('div');
        card.className = 'model-card';
        card.innerHTML = `
            <model-viewer
                src="${esc(srcFor(m))}"
                alt="${esc(m.name)}"
                loading="lazy"
                auto-rotate
                rotation-per-second="10deg"
                shadow-intensity="0.5"
                exposure="1"
                environment-image="neutral">
            </model-viewer>
            <div class="card-info">
                <div class="card-name">${esc(m.name)}</div>
                <div class="card-author">${esc(authorName(m.author))}</div>
                <div class="card-meta">
                    <span title="Views">
                        <svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
                        ${m.views || 0}
                    </span>
                    <span title="Likes">
                        <svg viewBox="0 0 24 24"><path d="M12 21C7 16.5 3 13.3 3 9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 4.3-4 7.5-9 12z"/></svg>
                        ${m.likes || 0}
                    </span>
                    ${m.downloadable ? `
                    <span title="Downloadable">
                        <svg viewBox="0 0 24 24"><path d="M12 3v12M6 9l6 6 6-6M4 21h16"/></svg>
                    </span>` : ''}
                    ${m.public === false ? `<span class="card-badge">${esc(t('card.private'))}</span>` : ''}
                </div>
            </div>`;

        // Клик по всей карточке (не только по названию) открывает модель
        card.addEventListener('click', () => openModel(m.id));
        gridEl.appendChild(card);
    });
}

// Поиск и фильтр категории в реальном времени
document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    if (document.getElementById('view-home').classList.contains('active')) renderHome();
});

document.getElementById('cat-filter').addEventListener('change', (e) => {
    categoryFilter = e.target.value;
    if (document.getElementById('view-home').classList.contains('active')) renderHome();
});

// ================= Страница модели =================

const stageWrap = document.getElementById('stage-wrap');
const viewerPanel = document.getElementById('viewer-panel');
const texViewer = document.getElementById('tex-viewer');
const texCanvas = document.getElementById('tex-canvas');
let stage = null;      // three.js просмотрщик (создаётся лениво)
let currentModel = null;

// Кнопка справа снизу открывает/закрывает левую панель настроек
document.getElementById('btn-panel').addEventListener('click', () => {
    const open = viewerPanel.classList.toggle('open');
    document.getElementById('btn-panel').classList.toggle('open', open);
});

// Переключатели панели → режимы ModelStage
function bindModeToggle(checkboxId, modeKey) {
    document.getElementById(checkboxId).addEventListener('change', (e) => {
        if (stage) stage.setMode(modeKey, e.target.checked);
    });
}
bindModeToggle('opt-nopost', 'noPost');
bindModeToggle('opt-autorotate', 'autorotate');
bindModeToggle('opt-wireframe', 'wireframe');
bindModeToggle('opt-normals', 'normals');
bindModeToggle('opt-bones', 'bones');

// --- Bones: список костей (передаётся из viewer.js) ---
const bonesList = document.getElementById('bones-list');
const bonesNote = document.getElementById('bones-note');

function renderBoneList(bones) {
    bonesList.innerHTML = '';
    if (!bones.length) {
        bonesNote.textContent = t('panel.bones_none');
        return;
    }
    bonesNote.textContent = t('panel.bones_note');
    bones.forEach(({ bone, depth }, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bone-item';
        btn.style.paddingLeft = (10 + depth * 12) + 'px';
        btn.textContent = bone.name || t('panel.bone', { n: i });
        btn.addEventListener('click', () => {
            bonesList.querySelectorAll('.bone-item').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            if (stage) stage.selectBone(bone);
        });
        bonesList.appendChild(btn);
    });
}

// --- Textures: список слотов текстур ---
const texList = document.getElementById('tex-list');

function renderTexList(textures) {
    texList.innerHTML = '';
    if (!textures.length) {
        texList.innerHTML = `<p class="vsec-note">${esc(t('panel.tex_none'))}</p>`;
        return;
    }
    textures.forEach(tx => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tex-item';
        btn.textContent = tx.label;
        btn.addEventListener('click', () => {
            texList.querySelectorAll('.tex-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            showTexture(tx.tex);
        });
        texList.appendChild(btn);
    });
}

// 2D-просмотр текстуры: без света и материалов, только сама текстура
function showTexture(tex) {
    try {
        const img = tex.image;
        texCanvas.width = img.width || 512;
        texCanvas.height = img.height || 512;
        texCanvas.getContext('2d').drawImage(img, 0, 0);
    } catch (err) {
        // например, сжатые текстуры нельзя нарисовать на canvas
        toast(t('tex.compressed'));
        return;
    }
    texViewer.classList.remove('hidden');
}

// Smooth / Pixelated — фильтрация текстуры (сглаживание vs пиксель-арт)
document.getElementById('tex-smooth').addEventListener('click', () => {
    texCanvas.classList.remove('pixelated');
    document.getElementById('tex-smooth').classList.add('active');
    document.getElementById('tex-pixel').classList.remove('active');
});
document.getElementById('tex-pixel').addEventListener('click', () => {
    texCanvas.classList.add('pixelated');
    document.getElementById('tex-pixel').classList.add('active');
    document.getElementById('tex-smooth').classList.remove('active');
});
document.getElementById('tex-close').addEventListener('click', () => {
    texViewer.classList.add('hidden');
    texList.querySelectorAll('.tex-item').forEach(b => b.classList.remove('active'));
});

async function openModel(id) {
    const all = await dbGetAll();
    const m = all.find(x => x.id === id);
    if (!m) return;

    // Счётчик просмотров
    m.views = (m.views || 0) + 1;
    await dbPut(m);
    currentModel = m;

    // Заполняем панель справа
    document.getElementById('md-name').textContent = m.name;
    document.getElementById('md-author').textContent = t('model.by', { name: authorName(m.author) });
    document.getElementById('md-desc').textContent = m.desc || t('model.no_desc');
    document.getElementById('md-views').textContent = t('model.views', { n: m.views });
    document.getElementById('md-likes').textContent = t('model.likes', { n: m.likes || 0 });
    document.getElementById('md-date').textContent = fmtDate(m.date);

    // Категория / лицензия / приватность
    const chips = [];
    if (m.category) chips.push(['accent', t('cat.' + m.category)]);
    if (m.license) chips.push(['', t('model.license', { v: m.license })]);
    if (m.public === false) chips.push(['', t('model.private')]);
    document.getElementById('md-chips').innerHTML =
        chips.map(([cls, text]) => `<span class="${cls}">${esc(text)}</span>`).join('');

    // Теги
    document.getElementById('md-tags').innerHTML =
        (m.tags || []).map(x => `<span>${esc(x)}</span>`).join('');

    // Скачивание: только если автор разрешил
    const dl = document.getElementById('md-download');
    if (m.downloadable) {
        dl.classList.remove('hidden');
        document.getElementById('md-no-download').classList.add('hidden');
        dl.href = srcFor(m);
        dl.download = m.name.replace(/[\\/:*?"<>|]+/g, '_') + '.glb';
    } else {
        dl.classList.add('hidden');
        document.getElementById('md-no-download').classList.remove('hidden');
    }

    // Удалить может автор или админ
    const me = currentUser();
    const canDelete = me && (me.user === m.author || me.admin);
    document.getElementById('md-delete').classList.toggle('hidden', !canDelete);

    // Кнопка «Like»
    updateLikeBtn();

    // Сбрасываем панель настроек и загружаем модель в three.js
    ['opt-nopost', 'opt-autorotate', 'opt-wireframe', 'opt-normals', 'opt-bones'].forEach(id => {
        document.getElementById(id).checked = false;
    });
    viewerPanel.classList.remove('open');
    document.getElementById('btn-panel').classList.remove('open');
    texViewer.classList.add('hidden');
    document.getElementById('tex-smooth').classList.add('active');
    document.getElementById('tex-pixel').classList.remove('active');
    texCanvas.classList.remove('pixelated');

    if (!stage) {
        stage = new ModelStage(document.getElementById('viewer-canvas'));
        stage.onBones = renderBoneList;
        stage.onTextures = renderTexList;
    }
    window.__stage = stage; // для отладки из консоли

    // Пост-обработка по умолчанию: выбор автора при выкладывании,
    // иначе — дефолт из Sttng
    const def = viewerDefaults();
    const noPost = m.noPost != null ? m.noPost : (def.noPost || false);
    document.getElementById('opt-nopost').checked = noPost;

    stage.load(srcFor(m), {
        noPost,
        autorotate: def.autorotate || false,
        wireframe: def.wireframe || false,
        normals: def.normals || false,
        showBones: def.showBones || false,
    });

    showView('model');
}

// Клик по имени автора открывает его профиль
document.getElementById('md-author').addEventListener('click', (e) => {
    e.preventDefault();
    if (currentModel) openProfile(currentModel.author);
});

// Кнопка «Like» (нужен аккаунт)
function updateLikeBtn() {
    const me = currentUser();
    const btn = document.getElementById('md-like');
    if (!me) {
        btn.textContent = t('model.like');
        btn.onclick = () => toast(t('toast.signin_like'));
        return;
    }
    const liked = getMyLikes().includes(currentModel.id);
    btn.textContent = liked ? t('model.liked') : t('model.like');
    btn.classList.toggle('primary', liked);
    btn.onclick = async () => {
        let likes = getMyLikes();
        if (likes.includes(currentModel.id)) {
            likes = likes.filter(x => x !== currentModel.id);
            currentModel.likes = Math.max(0, (currentModel.likes || 0) - 1);
        } else {
            likes.push(currentModel.id);
            currentModel.likes = (currentModel.likes || 0) + 1;
        }
        saveMyLikes(likes);
        await dbPut(currentModel);
        document.getElementById('md-likes').textContent = t('model.likes', { n: currentModel.likes || 0 });
        updateLikeBtn();
        if (document.getElementById('view-home').classList.contains('active')) renderHome();
    };
}

// Удаление модели (только автор или админ)
document.getElementById('md-delete').addEventListener('click', async () => {
    if (!currentModel) return;
    if (!confirm(t('model.delete_confirm', { name: currentModel.name }))) return;
    await dbDelete(currentModel.id);
    if (currentModel.blob) {
        const url = objectUrls.get(currentModel.id);
        if (url) { URL.revokeObjectURL(url); objectUrls.delete(currentModel.id); }
    }
    toast(t('toast.deleted'));
    currentModel = null;
    renderHome();
    showView('home');
});

// ================= Профиль =================

// Цвета аватара (используются и в Sttng, и здесь)
const AVATAR_COLORS = {
    cyan:   ['#1caad9', '#5865F2'],
    purple: ['#8b5cf6', '#ec4899'],
    green:  ['#22c58b', '#0ea5e9'],
    orange: ['#f59e0b', '#ef4444'],
    pink:   ['#ec4899', '#8b5cf6'],
    slate:  ['#64748b', '#334155'],
};

async function openProfile(userName) {
    const user = getUsers().find(u => u.user.toLowerCase() === userName.toLowerCase());
    const pf = (user && user.profile) || {};
    const displayName = (user && pf.name) || userName;

    document.getElementById('pf-name').textContent = displayName;
    document.getElementById('pf-bio').textContent = pf.bio || '';

    // Аватар: картинка, если загрузил, иначе буква на градиенте
    const av = document.getElementById('pf-avatar');
    if (pf.avatar) {
        av.style.background = `#000 url(${pf.avatar}) center/cover no-repeat`;
        av.textContent = '';
    } else {
        const pair = AVATAR_COLORS[pf.color || 'cyan'] || AVATAR_COLORS.cyan;
        av.style.background = `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`;
        av.textContent = displayName[0].toUpperCase();
    }

    document.getElementById('pf-joined').textContent = user
        ? t('profile.since', { d: fmtDate(user.joined) })
        : t('profile.demo');

    // Кнопка «Выйти» — только в своём профиле
    const me = currentUser();
    document.getElementById('pf-logout').classList.toggle('hidden', !me || me.user.toLowerCase() !== userName.toLowerCase());

    const all = await dbGetAll();
    // В профиле автора чужие приватные модели не показываем
    const mine = all
        .filter(m => m.author.toLowerCase() === userName.toLowerCase())
        .filter(m => m.public !== false || (me && (me.user.toLowerCase() === userName.toLowerCase() || me.admin)))
        .sort((a, b) => b.date - a.date);

    document.getElementById('profile-empty').classList.toggle('hidden', mine.length > 0);
    renderGrid(document.getElementById('profile-grid'), mine);
    showView('profile');
}

document.getElementById('pf-logout').addEventListener('click', logout);

// Логотип всегда возвращает на главную
document.getElementById('logo-home').addEventListener('click', (e) => {
    e.preventDefault();
    showView('home');
    renderHome();
});

// ================= Выкладывание модели =================

const uploadModal = document.getElementById('upload-modal');
const upDrop = document.getElementById('up-drop');
const upInput = document.getElementById('up-file-input');
const upName = document.getElementById('up-name');
let pendingFile = null;

document.getElementById('upload-open').addEventListener('click', () => {
    if (!currentUser()) {
        toast(t('toast.signin_upload'));
        openAuthModal('register');
        return;
    }
    resetUploadForm();
    uploadModal.classList.remove('hidden');
});

document.getElementById('upload-close').addEventListener('click', () => uploadModal.classList.add('hidden'));
uploadModal.addEventListener('click', (e) => {
    if (e.target === uploadModal) uploadModal.classList.add('hidden');
});

function resetUploadForm() {
    pendingFile = null;
    upName.value = '';
    document.getElementById('up-desc').value = '';
    document.getElementById('up-category').value = '';
    document.getElementById('up-tags').value = '';
    document.getElementById('up-license').value = 'CC-BY';
    document.getElementById('up-public').checked = true;
    document.getElementById('up-downloadable').checked = true;
    document.getElementById('up-post').value = 'default';
    document.getElementById('up-rules').checked = false;
    document.getElementById('up-file-name').classList.add('hidden');
    upInput.value = '';
}

// Выбор файла: клик по кнопке или drag & drop
document.getElementById('up-file-btn').addEventListener('click', () => upInput.click());
upInput.addEventListener('change', () => {
    if (upInput.files.length) takeFile(upInput.files[0]);
    upInput.value = '';
});

upDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    upDrop.classList.add('dragover');
});
upDrop.addEventListener('dragleave', () => upDrop.classList.remove('dragover'));
upDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    upDrop.classList.remove('dragover');
    if (e.dataTransfer.files.length) takeFile(e.dataTransfer.files[0]);
});

function takeFile(file) {
    const name = file.name.toLowerCase();
    if (!name.endsWith('.glb') && !name.endsWith('.gltf')) {
        return toast(t('toast.file_invalid'));
    }
    pendingFile = file;
    const el = document.getElementById('up-file-name');
    el.textContent = '✔ ' + file.name + ' (' + fileSize(file.size) + ')';
    el.classList.remove('hidden');
    if (!upName.value.trim()) upName.value = file.name.replace(/\.(glb|gltf)$/i, '');
}

document.getElementById('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const me = currentUser();
    if (!me) { uploadModal.classList.add('hidden'); return openAuthModal('register'); }
    if (!pendingFile) return toast(t('toast.choose_file'));
    if (!document.getElementById('up-rules').checked) return toast(t('toast.rules_first'));

    const model = {
        name: upName.value.trim() || pendingFile.name,
        desc: document.getElementById('up-desc').value.trim(),
        category: document.getElementById('up-category').value,
        tags: document.getElementById('up-tags').value.split(',').map(x => x.trim()).filter(Boolean),
        license: document.getElementById('up-license').value,
        public: document.getElementById('up-public').checked,
        downloadable: document.getElementById('up-downloadable').checked,
        noPost: document.getElementById('up-post').value === 'none',
        author: me.user,
        blob: pendingFile,
        date: Date.now(),
        views: 0,
        likes: 0,
    };

    const id = await dbPut(model);
    if (id == null) return toast(t('toast.save_fail'));

    uploadModal.classList.add('hidden');
    toast(t('toast.published'));
    await renderHome();
    showView('home');
    openModel(id); // сразу показываем, как это делает Sketchfab
});

// ================= Демо-модели (только при самом первом запуске) =================

async function seedDemoModels() {
    const all = await dbGetAll();

    // Миграция: старые демо-модели без категории/лицензии удаляем,
    // чтобы засеять их заново с новыми полями
    const oldDemo = all.filter(m => m.src && m.author === 'MeshFab' && !m.category);
    for (const m of oldDemo) await dbDelete(m.id);

    if (all.length !== oldDemo.length || localStorage.getItem('mf_seeded_v2')) return;

    const demo = [
        {
            name: 'Astronaut',
            desc: 'An astronaut in a space suit. Free demo model from modelviewer.dev.',
            category: 'Characters',
            tags: ['astronaut', 'sci-fi', 'demo'],
            license: 'CC-BY',
            public: true,
            downloadable: true,
            noPost: false,
            author: 'MeshFab',
            src: 'https://modelviewer.dev/shared-assets/models/Astronaut.glb',
            date: Date.now(), views: 14, likes: 3,
        },
        {
            name: 'Robot Expressive',
            desc: 'An animated robot with bones (rigged). Try the Bones section in the viewer settings!',
            category: 'Characters',
            tags: ['robot', 'rigged', 'demo'],
            license: 'CC-BY',
            public: true,
            downloadable: true,
            noPost: false,
            author: 'MeshFab',
            src: 'https://modelviewer.dev/shared-assets/models/RobotExpressive.glb',
            date: Date.now(), views: 9, likes: 2,
        },
        {
            name: 'Horse (no download)',
            desc: 'Example of a model with downloads disabled by the author — no Download button here.',
            category: 'Creatures',
            tags: ['horse', 'animal', 'demo'],
            license: 'CC-BY',
            public: true,
            downloadable: false,
            noPost: false,
            author: 'MeshFab',
            src: 'https://modelviewer.dev/shared-assets/models/Horse.glb',
            date: Date.now(), views: 5, likes: 1,
        },
    ];

    for (const m of demo) await dbPut(m);
    localStorage.setItem('mf_seeded_v2', '1');
}

// ================= Запуск =================

(async () => {
    applyI18n();
    db = await openDB();
    await seedDemoModels();
    renderAuthArea();
    await renderHome();
})();
