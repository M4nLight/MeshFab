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

// ================= Баны аккаунтов =================

// Активен ли бан: timed истекает по дате, permanent и publish — нет
function banActive(u) {
    const b = u && u.ban;
    if (!b) return null;
    if (b.type === 'timed' && (!b.until || b.until <= Date.now())) return null;
    return b;
}

// Текст статуса бана (для профиля и админки)
function banText(u, keyBase) {
    const b = banActive(u);
    if (!b) return t('ban.none');
    let text;
    if (b.type === 'permanent') text = t(keyBase + '_perm');
    else if (b.type === 'publish') text = t(keyBase + '_publish');
    else text = t(keyBase + '_timed', { date: fmtDate(b.until) });
    if (b.reason) text += ' · ' + t('ban.reason_label', { r: b.reason });
    return text;
}

// ================= Уведомления (в localStorage, у каждого свои) =================

// У каждого юзера свой список: mf_notifs_<имя>. Уведомления видит только он —
// сайт работает по островкам (все данные живут в браузере).
const notifsKey = (user) => 'mf_notifs_' + user.toLowerCase();

function getNotifs(user) {
    return JSON.parse(localStorage.getItem(notifsKey(user || (currentUser() || {}).user)) || '[]');
}

function saveNotifs(user, list) {
    localStorage.setItem(notifsKey(user), JSON.stringify(list));
    updateBellBadge();
}

// Добавить уведомление юзеру (user — кому)
function notify(user, obj) {
    const list = getNotifs(user);
    list.unshift({
        id: Date.now() + Math.random().toString(36).slice(2, 7),
        read: false,
        date: Date.now(),
        ...obj,
    });
    if (list.length > 50) list.length = 50; // не раздувать память
    saveNotifs(user, list);
}

const unreadNotifs = (user) => getNotifs(user).filter(n => !n.read).length;

// Обновляет красную цифру на колокольчике
function updateBellBadge() {
    const el = document.getElementById('notif-count');
    if (!el) return;
    const me = currentUser();
    const n = me ? unreadNotifs(me.user) : 0;
    el.textContent = n > 99 ? '99+' : n;
    el.classList.toggle('hidden', n === 0);
}

// ================= Жалобы (админ видит уведомление) =================

const REPORTS_KEY = 'mf_reports';
const getReports = () => JSON.parse(localStorage.getItem(REPORTS_KEY) || '[]');
const saveReports = (list) => localStorage.setItem(REPORTS_KEY, JSON.stringify(list));

// ================= Достижения моделей (просмотры / лайки) =================

const ACH_VIEWS = [10, 50, 100, 500, 1000];
const ACH_LIKES = [5, 10, 25, 50, 100];

// Проверяет, перевалила ли модель новый порог. Если да — автор получает
// уведомление («100 просмотров!»). Возвращает true, если надо сохранить модель.
function checkAchievements(m) {
    m.ach = m.ach || { views: 0, likes: 0 };
    let changed = false;
    for (const n of ACH_VIEWS) {
        if ((m.views || 0) >= n && m.ach.views < n) {
            m.ach.views = n;
            changed = true;
            if (m.author !== (currentUser() || {}).user) {
                notify(m.author, { type: 'ach', text: t('ach.views', { model: m.name, n }), modelId: m.id });
            }
        }
    }
    for (const n of ACH_LIKES) {
        if ((m.likes || 0) >= n && m.ach.likes < n) {
            m.ach.likes = n;
            changed = true;
            if (m.author !== (currentUser() || {}).user) {
                notify(m.author, { type: 'ach', text: t('ach.likes', { model: m.name, n }), modelId: m.id });
            }
        }
    }
    return changed;
}

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

    // Забаненный (timed/permanent) не может войти; ban по публикациям — может
    const ban = banActive(found);
    if (ban && ban.type !== 'publish') {
        return {
            error: ban.type === 'permanent'
                ? t('ban.login_perm', { r: ban.reason || '—' })
                : t('ban.login_until', { date: fmtDate(ban.until), r: ban.reason || '—' }),
        };
    }

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
    const bellArea = document.getElementById('notif-area');
    const u = currentUser();
    if (u) {
        // Колокольчик живёт в отдельном контейнере — левее кнопки Upload
        bellArea.innerHTML = `
            <div class="notif-wrap">
                <button class="notif-btn" id="notif-btn" type="button" title="${esc(t('nav.notifs'))}">
                    <svg><use href="#i-bell"/></svg>
                    <span class="notif-count hidden" id="notif-count">0</span>
                </button>
                <div class="notif-menu hidden" id="notif-menu"></div>
            </div>`;
        document.getElementById('notif-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = document.getElementById('notif-menu');
            menu.classList.toggle('hidden');
            if (!menu.classList.contains('hidden')) renderNotifMenu();
        });
        // Клик мимо меню — закрыть его
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('notif-menu');
            if (menu && !menu.classList.contains('hidden') && !e.target.closest('.notif-wrap')) {
                menu.classList.add('hidden');
            }
        });
        // Чип аккаунта + стрелочка: быстрое переключение между аккаунтами
        area.innerHTML = `
            <div class="acc-switch">
                <button class="btn user-chip" id="user-chip" type="button" title="My profile">${esc(authorName(u.user))}</button>
                <button class="acc-switch-btn" id="acc-switch-btn" type="button" title="${esc(t('nav.switch'))}">
                    <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <div class="acc-switch-menu hidden" id="acc-switch-menu"></div>
            </div>`;
        document.getElementById('user-chip').addEventListener('click', () => openProfile(u.user));
        document.getElementById('acc-switch-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            renderAccSwitchMenu();
            document.getElementById('acc-switch-menu').classList.toggle('hidden');
        });
        updateBellBadge();
    } else {
        bellArea.innerHTML = '';
        area.innerHTML = `
            <a class="btn" href="auth.html" data-i18n="nav.signin">Sign in</a>
            <a class="btn primary" href="auth.html?mode=register" data-i18n="nav.signup">Sign up</a>`;
        applyI18n(area);
    }
}

// ================= Переключение аккаунтов =================

function renderAccSwitchMenu() {
    const me = currentUser();
    const menu = document.getElementById('acc-switch-menu');
    if (!me || !menu) return;
    const users = getUsers();
    menu.innerHTML = users.map(x => `
        <button class="acc-switch-item ${x.user.toLowerCase() === me.user.toLowerCase() ? 'current' : ''}" data-user="${esc(x.user)}" type="button">
            <span class="acc-dot" style="--c:${(x.profile && x.profile.color) || 'cyan'}"></span>
            <span>${esc(authorName(x.user))}</span>
            ${x.user.toLowerCase() === me.user.toLowerCase() ? '<span class="acc-check">✔</span>' : ''}
        </button>`).join('') + `
        <a class="acc-switch-item add" href="auth.html?mode=register">${esc(t('nav.add_account'))}</a>`;

    menu.querySelectorAll('.acc-switch-item[data-user]').forEach(btn =>
        btn.addEventListener('click', () => {
            localStorage.setItem(SESSION_KEY, btn.dataset.user);
            menu.classList.add('hidden');
            renderAuthArea();
            renderHome();
            toast(t('toast.switched', { name: authorName(btn.dataset.user) }));
        }));
}

// Клик мимо меню переключения — закрыть
document.addEventListener('click', (e) => {
    const menu = document.getElementById('acc-switch-menu');
    if (menu && !menu.classList.contains('hidden') && !e.target.closest('.acc-switch')) {
        menu.classList.add('hidden');
    }
});

// ================= Меню уведомлений =================

function renderNotifMenu() {
    const me = currentUser();
    const menu = document.getElementById('notif-menu');
    if (!me || !menu) return;
    const list = getNotifs(me.user);
    menu.innerHTML = `
        <div class="notif-menu-head">
            <span>${esc(t('notifs.title'))}</span>
            ${list.length ? `<button class="notif-clear" id="notif-clear" type="button">${esc(t('notifs.clear'))}</button>` : ''}
        </div>
        ${list.length
            ? list.map(n => `
                <button class="notif-item ${n.read ? '' : 'unread'}" data-nid="${esc(n.id)}" type="button">
                    ${esc(n.text)}
                    <span class="notif-date">${fmtDate(n.date)}</span>
                </button>`).join('')
            : `<div class="notif-empty">${esc(t('notifs.empty'))}</div>`}`;

    const clear = document.getElementById('notif-clear');
    if (clear) clear.addEventListener('click', () => {
        saveNotifs(me.user, []);
        renderNotifMenu();
    });

    menu.querySelectorAll('.notif-item').forEach(btn =>
        btn.addEventListener('click', () => openNotif(btn.dataset.nid)));
}

// Клик по уведомлению: пометить прочитанным, жалобу — обработанной, открыть модель
async function openNotif(nid) {
    const me = currentUser();
    if (!me) return;
    const list = getNotifs(me.user);
    const n = list.find(x => x.id === nid);
    if (!n) return;
    if (!n.read) {
        n.read = true;
        saveNotifs(me.user, list);
    }
    // Жалоба считается просмотренной — убираем из списка админа
    if (n.type === 'report' && n.reportId) {
        const reps = getReports().filter(r => r.id !== n.reportId);
        saveReports(reps);
    }
    document.getElementById('notif-menu').classList.add('hidden');
    updateBellBadge();
    if (n.modelId) await openModel(n.modelId);
}

// Вход/регистрация теперь на отдельной странице auth.html
// (тут только переход по ссылкам из шапки)

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
                <div class="card-name-row">
                    <div class="card-name ${m.feat >= 3 ? 'feat-name-' + m.feat : ''}">${esc(m.name)}</div>
                    ${m.feat >= 1 ? `<span class="mini-feat" data-level="${m.feat}" title="${esc(t('feat.title'))}"><svg><use href="#i-flame"/></svg></span>` : ''}
                </div>
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

// Просмотр засчитывается один раз на устройство: id моделей, которые уже смотрели
const seenKey = 'mf_seen';
const seenModels = () => JSON.parse(localStorage.getItem(seenKey) || '[]');
const markModelSeen = (id) => {
    const arr = seenModels();
    if (!arr.includes(id)) {
        arr.push(id);
        localStorage.setItem(seenKey, JSON.stringify(arr));
    }
};

const stageWrap = document.getElementById('stage-wrap');
const viewerPanel = document.getElementById('viewer-panel');
const texViewer = document.getElementById('tex-viewer');
const texCanvas = document.getElementById('tex-canvas');
let stage = null;      // three.js просмотрщик (создаётся лениво)
let currentModel = null;
let currentProfileUser = null; // чей профиль открыт (для фичера аккаунта)

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

    // Счётчик просмотров: один раз на устройство, повторные заходы не считаются
    if (!seenModels().includes(id)) {
        m.views = (m.views || 0) + 1;
        markModelSeen(id);
        await dbPut(m);
    }
    // Достижения по просмотрам (уведомление автору о «100 просмотров» и т.д.)
    if (checkAchievements(m)) await dbPut(m);
    currentModel = m;

    // Заполняем панель справа
    document.getElementById('md-name').textContent = m.name;
    document.getElementById('md-author').textContent = t('model.by', { name: authorName(m.author) });

    // Фичер модели: бейдж у названия + панель выбора уровня (только админ)
    renderFeatBadge(m);
    document.getElementById('md-admin-tools').classList.toggle('hidden', !isAdmin());
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

    // Жаловаться на свою модель (или админом) бессмысленно — прячем кнопку
    document.getElementById('md-report').classList.toggle('hidden', Boolean(me && (me.user === m.author || me.admin)));

    // Комментарии под моделью
    renderComments();
    updateCommentArea();

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
        // Достижения по лайкам («10 лайков!» и т.д.)
        if (checkAchievements(currentModel)) await dbPut(currentModel);
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

// ================= Фичеры (уровни 1–5, задаёт админ) =================

// Рисует бейдж огня у названия модели + подсвечивает кнопки админа
function renderFeatBadge(m) {
    const badge = document.getElementById('md-feat');
    const name = document.getElementById('md-name');
    [3, 4, 5].forEach(l => name.classList.remove('feat-name-' + l));
    if (m.feat >= 1) {
        badge.classList.remove('hidden');
        badge.dataset.level = m.feat;
        if (m.feat >= 3) name.classList.add('feat-name-' + m.feat);
    } else {
        badge.classList.add('hidden');
    }
    syncFeatPicker('md-feat-picker', m.feat || 0);
}

// Подсветка активной кнопки уровня в админ-панели
function syncFeatPicker(pickerId, level) {
    const picker = document.getElementById(pickerId);
    if (!picker) return;
    picker.querySelectorAll('.feat-pick').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.feat, 10) === level));
}

// Клик по огоньку уровня — сохранить фичер модели
document.getElementById('md-feat-picker').addEventListener('click', async (e) => {
    const btn = e.target.closest('.feat-pick');
    if (!btn || !currentModel) return;
    currentModel.feat = parseInt(btn.dataset.feat, 10);
    await dbPut(currentModel);
    renderFeatBadge(currentModel);
    toast(t('feat.saved'));
    renderHome(); // перерисовать карточки с огоньком
});

// Клик по огоньку уровня — сохранить фичер аккаунта
document.getElementById('pf-feat-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('.feat-pick');
    if (!btn || !currentProfileUser) return;
    const users = getUsers();
    const u = users.find(x => x.user.toLowerCase() === currentProfileUser.toLowerCase());
    if (!u) return;
    u.feat = parseInt(btn.dataset.feat, 10);
    saveUsers(users);
    renderProfileFeat(u);
    toast(t('feat.saved'));
});

// Огненное кольцо за аватаром профиля
function renderProfileFeat(user) {
    const ring = document.getElementById('pf-ring');
    ring.classList.remove('feat-1', 'feat-2', 'feat-3', 'feat-4', 'feat-5');
    const lvl = (user && user.feat) || 0;
    if (lvl >= 1) ring.classList.add('feat-' + lvl);
    syncFeatPicker('pf-feat-picker', lvl);
    document.getElementById('pf-admin-tools').classList.toggle('hidden', !isAdmin());
    // Бан: красный бейдж видят все, статус в админ-панели — админ
    renderBanBadge(user);
    if (isAdmin()) renderBanStatus(user);
}

// Красный бейдж «ЗАБАНЕН» в шапке профиля
function renderBanBadge(user) {
    const el = document.getElementById('pf-ban');
    if (!el) return;
    const b = banActive(user);
    el.classList.toggle('hidden', !b);
    if (!b) return;
    let text = b.type === 'permanent' ? t('ban.badge_perm')
        : b.type === 'publish' ? t('ban.badge_publish')
        : t('ban.badge_timed', { date: fmtDate(b.until) });
    el.textContent = text;
}

// Строка статуса внутри админ-панели банов
function renderBanStatus(user) {
    const el = document.getElementById('ban-status');
    if (!el) return;
    el.textContent = banText(user, 'ban.status');
}

// Кнопки бана: срок / навсегда / запрет публикаций / снять
document.getElementById('ban-buttons').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ban]');
    if (!btn || !currentProfileUser) return;
    const users = getUsers();
    const u = users.find(x => x.user.toLowerCase() === currentProfileUser.toLowerCase());
    if (!u) return;
    const kind = btn.dataset.ban;

    if (kind === 'remove') {
        u.ban = null;
        toast(t('ban.removed'));
    } else {
        const reason = document.getElementById('ban-reason').value.trim();
        const now = Date.now();
        const DAY = 86400000;
        u.ban = {
            type: kind === 'permanent' ? 'permanent' : kind === 'publish' ? 'publish' : 'timed',
            until: kind === 'day' ? now + DAY : kind === 'week' ? now + 7 * DAY : kind === 'month' ? now + 30 * DAY : null,
            reason,
        };
        toast(t('ban.saved'));
    }
    saveUsers(users);

    // Если забанили того, кто прямо сейчас сидит в этом браузере — выкидываем
    const me = currentUser();
    if (me && me.user.toLowerCase() === u.user.toLowerCase()) {
        const b = banActive(u);
        if (b && b.type !== 'publish') {
            localStorage.removeItem(SESSION_KEY);
            renderAuthArea();
        }
    }
    renderBanBadge(u);
    renderBanStatus(u);
});

// ================= Комментарии под моделью =================

function renderComments() {
    const m = currentModel;
    if (!m) return;
    const list = document.getElementById('comments-list');
    const empty = document.getElementById('comments-empty');
    const comments = m.comments || [];

    list.innerHTML = comments.map(c => `
        <div class="comment" data-cid="${esc(c.id)}">
            <div class="comment-head">
                <button class="comment-author" data-user="${esc(c.by)}" type="button">${esc(authorName(c.by))}</button>
                <span class="comment-date">${fmtDate(c.date)}</span>
                ${(currentUser() && (currentUser().user === c.by || currentUser().admin))
                    ? `<button class="comment-del" type="button">${esc(t('comments.del'))}</button>` : ''}
            </div>
            <div class="comment-text">${esc(c.text)}</div>
        </div>`).join('');

    empty.classList.toggle('hidden', comments.length > 0);

    // Клик по имени автора комментария — открыть его профиль
    list.querySelectorAll('.comment-author').forEach(b =>
        b.addEventListener('click', () => openProfile(b.dataset.user)));
    // Крестик — удалить свой (или админ любой)
    list.querySelectorAll('.comment-del').forEach(b =>
        b.addEventListener('click', async () => {
            const cid = b.closest('.comment').dataset.cid;
            currentModel.comments = currentModel.comments.filter(c => c.id !== cid);
            await dbPut(currentModel);
            renderComments();
        }));
}

// Форма комментария: гостю — подсказка, юзеру — отправка
function updateCommentArea() {
    const me = currentUser();
    document.querySelector('#comment-form button[type=submit]').disabled = !me;
    document.getElementById('comment-input').disabled = !me;
    document.getElementById('comments-guest').classList.toggle('hidden', !!me);
    if (!me) document.getElementById('comments-list').innerHTML = '';
}

document.getElementById('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const me = currentUser();
    if (!me || !currentModel) return;
    const input = document.getElementById('comment-input');
    const text = input.value.trim();
    if (!text) return;
    currentModel.comments = currentModel.comments || [];
    currentModel.comments.push({
        id: Date.now() + Math.random().toString(36).slice(2, 7),
        by: me.user,
        text,
        date: Date.now(),
    });
    await dbPut(currentModel);
    input.value = '';
    renderComments();
    // Автор модели получает уведомление (если комментирует не он сам)
    if (currentModel.author !== me.user) {
        notify(currentModel.author, {
            type: 'comment',
            text: t('notifs.comment', { who: authorName(me.user), model: currentModel.name }),
            modelId: currentModel.id,
        });
    }
});

// ================= Жалоба на модель (модалка) =================

const reportModal = document.getElementById('report-modal');

document.getElementById('md-report').addEventListener('click', () => {
    if (!currentModel) return;
    if (!currentUser()) return toast(t('toast.signin_report'));
    document.getElementById('report-text').value = '';
    reportModal.classList.remove('hidden');
});

document.getElementById('report-close').addEventListener('click', () => reportModal.classList.add('hidden'));
reportModal.addEventListener('click', (e) => {
    if (e.target === reportModal) reportModal.classList.add('hidden');
});

document.getElementById('report-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const me = currentUser();
    if (!me || !currentModel) return;
    const id = Date.now() + Math.random().toString(36).slice(2, 7);
    const reports = getReports();
    reports.push({
        id,
        modelId: currentModel.id,
        modelName: currentModel.name,
        by: me.user,
        text: document.getElementById('report-text').value.trim(),
        date: Date.now(),
    });
    saveReports(reports);
    // Все админы получают уведомление о жалобе
    getUsers().filter(u => u.admin).forEach(admin =>
        notify(admin.user, {
            type: 'report',
            reportId: id,
            text: t('notifs.report', { who: authorName(me.user), model: currentModel.name }),
            modelId: currentModel.id,
        }));
    reportModal.classList.add('hidden');
    toast(t('report.sent'));
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
    currentProfileUser = userName;

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

    // Фичер аккаунта: огонь за аватаром + панель выбора уровня (только админ)
    renderProfileFeat(user);

    showView('profile');
}

// ================= Визард выхода (5 подтверждений, как в GitHub) =================

let logoutStep = 0;

function openLogoutWizard() {
    logoutStep = 0;
    document.getElementById('logout-modal').classList.remove('hidden');
    renderLogoutStep();
}

function renderLogoutStep() {
    const bar = document.getElementById('logout-progress');
    const text = document.getElementById('logout-step-text');
    const btn = document.getElementById('logout-confirm');
    bar.style.width = (logoutStep / 5 * 100) + '%';
    text.textContent = t('logout.step' + (logoutStep + 1));
    btn.textContent = logoutStep === 4 ? t('logout.final') : t('logout.next');
}

document.getElementById('pf-logout').addEventListener('click', openLogoutWizard);

document.getElementById('logout-confirm').addEventListener('click', () => {
    logoutStep++;
    if (logoutStep >= 5) {
        document.getElementById('logout-modal').classList.add('hidden');
        logout();
        return;
    }
    renderLogoutStep();
});

document.getElementById('logout-cancel').addEventListener('click', () =>
    document.getElementById('logout-modal').classList.add('hidden'));
document.getElementById('logout-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('logout-modal')) {
        document.getElementById('logout-modal').classList.add('hidden');
    }
});

// Логотип всегда возвращает на главную
document.getElementById('logo-home').addEventListener('click', (e) => {
    e.preventDefault();
    showView('home');
    renderHome();
});

// ================= Выкладывание модели =================

// Форма загрузки живёт на отдельной странице upload.html
document.getElementById('upload-open').addEventListener('click', () => {
    if (!currentUser()) {
        location.href = 'auth.html?mode=register';
        return;
    }
    // Запрет публикаций: бан типа «publish»
    const ban = banActive(currentUser());
    if (ban && ban.type === 'publish') {
        toast(t('ban.upload_blocked', { r: ban.reason || '—' }));
        return;
    }
    location.href = 'upload.html';
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
    // Возврат с upload.html: index.html#m=<id> — сразу открыть свежевыложенную модель
    const mHash = location.hash.match(/^#m=(\d+)$/);
    if (mHash) {
        history.replaceState(null, '', location.pathname);
        openModel(parseInt(mHash[1], 10));
    }
})();
