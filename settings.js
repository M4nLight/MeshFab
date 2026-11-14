/* ============================================================
   Sttng — страница настроек MeshFab.
   - тема/акцент: localStorage, работают на всём сайте
   - аккаунты: PBKDF2-хеши (см. script.js), гости видят только «зарегайся»
   - опасные операции (удаление моделей/полный сброс): только админ
   - кастомизация профиля: имя, био, аватар-картинка, цвет
   - язык: en / ru / es / zh
============================================================ */

const USERS_KEY = 'mf_users';
const SESSION_KEY = 'mf_session';

const hashPass = (p) => btoa(unescape(encodeURIComponent('mf:' + p))); // только для миграции старых аккаунтов
const getUsers = () => JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
const saveUsers = (users) => localStorage.setItem(USERS_KEY, JSON.stringify(users));
const currentUser = () => {
    const name = localStorage.getItem(SESSION_KEY);
    return name ? getUsers().find(u => u.user === name) || null : null;
};
const isAdmin = () => { const u = currentUser(); return !!(u && u.admin); };

// Хеширование пароля — как в script.js (PBKDF2-SHA256)
const PBKDF2_ITERATIONS = 150000;
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

let toastTimer = null;
function toast(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Дата в локали текущего языка
function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(DATE_LOCALES[LANG] || 'en-US');
}

// ================= Вкладки слева (учитываем #hash для ссылок) =================

function openSection(sec) {
    document.querySelectorAll('.snav-item').forEach(b => b.classList.toggle('active', b.dataset.sec === sec));
    document.querySelectorAll('.ssec').forEach(s => s.classList.toggle('active', s.id === 'sec-' + sec));
}

document.querySelectorAll('.snav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        openSection(btn.dataset.sec);
        history.replaceState(null, '', '#' + btn.dataset.sec);
    });
});

// ================= Personalization: тема и акцент =================

function applyTheme() {
    const theme = localStorage.getItem('mf_theme') || 'dark';
    const accent = localStorage.getItem('mf_accent') || 'cyan';
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    document.querySelectorAll('[data-theme-set]').forEach(b =>
        b.classList.toggle('active', b.dataset.themeSet === theme));
    document.querySelectorAll('[data-theme-set]').forEach(c => {
        const mark = c.querySelector('.current-mark');
        if (mark) mark.classList.toggle('hidden', c.dataset.themeSet !== theme);
    });
    document.querySelectorAll('[data-accent-set]').forEach(b =>
        b.classList.toggle('active', b.dataset.accentSet === accent));
}

document.querySelectorAll('[data-theme-set]').forEach(btn => {
    btn.addEventListener('click', () => {
        localStorage.setItem('mf_theme', btn.dataset.themeSet);
        applyTheme();
        toast((btn.dataset.themeSet === 'dark' ? 'Dark theme' : 'Light theme') + ' ✓');
    });
});

document.querySelectorAll('[data-accent-set]').forEach(btn => {
    btn.addEventListener('click', () => {
        localStorage.setItem('mf_accent', btn.dataset.accentSet);
        applyTheme();
    });
});

applyTheme();

// ================= Профиль: кастомизация =================

// Цвета аватара — как в script.js
const AVATAR_COLORS = {
    cyan:   ['#1caad9', '#5865F2'],
    purple: ['#8b5cf6', '#ec4899'],
    green:  ['#22c58b', '#0ea5e9'],
    orange: ['#f59e0b', '#ef4444'],
    pink:   ['#ec4899', '#8b5cf6'],
    slate:  ['#64748b', '#334155'],
};

let pendingAvatarData = null;   // новая картинка до сохранения
let pendingAvatarRemove = false;
let pendingAvatarColor = null;

function renderProfileTab() {
    const u = currentUser();
    const guest = document.getElementById('profile-guest');
    const editor = document.getElementById('profile-editor');
    guest.classList.toggle('hidden', !!u);
    editor.classList.toggle('hidden', !u);
    if (!u) return;

    const pf = u.profile || {};
    pendingAvatarData = null;
    pendingAvatarRemove = false;
    pendingAvatarColor = pf.color || 'cyan';

    document.getElementById('pf-preview-user').textContent = u.user;
    document.getElementById('pf-name-input').value = pf.name || '';
    document.getElementById('pf-bio-input').value = pf.bio || '';
    renderProfilePreview();

    document.querySelectorAll('#pf-color-row .accent-dot').forEach(b =>
        b.classList.toggle('active', b.dataset.avatarColor === pendingAvatarColor));
}

function renderProfilePreview() {
    const u = currentUser();
    if (!u) return;
    const pf = u.profile || {};
    const name = document.getElementById('pf-name-input').value.trim() || u.user;
    document.getElementById('pf-preview-name').textContent = name;

    const av = document.getElementById('pf-preview-avatar');
    const useData = pendingAvatarRemove ? '' : (pendingAvatarData || pf.avatar || '');
    if (useData) {
        av.style.background = `#000 url(${useData}) center/cover no-repeat`;
        av.textContent = '';
    } else {
        const pair = AVATAR_COLORS[pendingAvatarColor || 'cyan'] || AVATAR_COLORS.cyan;
        av.style.background = `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`;
        av.textContent = name[0].toUpperCase();
    }
}

document.getElementById('pf-name-input').addEventListener('input', renderProfilePreview);

// Загрузка картинки аватара: сжимаем до 128×128 и храним как dataURL
document.getElementById('pf-avatar-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    if (!file.type.startsWith('image/')) return toast('Image files only');

    const img = new Image();
    img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const ctx = c.getContext('2d');
        // обрезаем по центру в квадрат
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128);
        pendingAvatarData = c.toDataURL('image/jpeg', 0.85);
        pendingAvatarRemove = false;
        renderProfilePreview();
    };
    img.src = URL.createObjectURL(file);
});

document.getElementById('pf-avatar-remove').addEventListener('click', () => {
    pendingAvatarRemove = true;
    pendingAvatarData = null;
    renderProfilePreview();
});

document.querySelectorAll('#pf-color-row .accent-dot').forEach(btn => {
    btn.addEventListener('click', () => {
        pendingAvatarColor = btn.dataset.avatarColor;
        pendingAvatarRemove = false;
        pendingAvatarData = null;
        document.querySelectorAll('#pf-color-row .accent-dot').forEach(b =>
            b.classList.toggle('active', b === btn));
        renderProfilePreview();
    });
});

document.getElementById('pf-save').addEventListener('click', () => {
    const u = currentUser();
    if (!u) return;
    const users = getUsers();
    const found = users.find(x => x.user === u.user);
    found.profile = {
        name: document.getElementById('pf-name-input').value.trim(),
        bio: document.getElementById('pf-bio-input').value.trim(),
        avatar: pendingAvatarRemove ? '' : (pendingAvatarData || (u.profile || {}).avatar || ''),
        color: pendingAvatarColor,
    };
    saveUsers(users);
    renderProfileTab();
    toast(t('toast.profile_saved_short'));
});

// ================= Account (гости видят только «зарегайся») =================

function renderAccount() {
    const u = currentUser();
    const guest = document.getElementById('account-guest');
    const editor = document.getElementById('account-editor');
    guest.classList.toggle('hidden', !!u);
    editor.classList.toggle('hidden', !u);
    if (!u) return;

    document.getElementById('st-avatar').textContent = (u.profile && u.profile.name || u.user)[0].toUpperCase();
    document.getElementById('st-name').textContent = (u.profile && u.profile.name) || u.user;
    document.getElementById('st-joined').textContent = t('profile.since', { d: fmtDate(u.joined) });
}

// Смена пароля (PBKDF2)
document.getElementById('st-pass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = currentUser();
    if (!u) return toast(t('toast.admin_only'));

    const oldPass = document.getElementById('st-old-pass').value;
    const newPass = document.getElementById('st-new-pass').value;

    // проверяем текущий пароль (учитывая старую схему, если аккаунт ещё не мигрировал)
    let ok;
    if (u.salt) {
        ok = u.pass === await pbkdf2(oldPass, u.salt, u.iterations || PBKDF2_ITERATIONS);
    } else {
        ok = u.pass === hashPass(oldPass);
    }
    if (!ok) return toast(t('toast.wrong_old'));

    const { salt, hash, iterations } = await hashPassword(newPass);
    const users = getUsers();
    const found = users.find(x => x.user === u.user);
    found.salt = salt; found.pass = hash; found.iterations = iterations;
    saveUsers(users);
    document.getElementById('st-pass-form').reset();
    toast(t('toast.updated'));
});

// Выход
document.getElementById('st-logout').addEventListener('click', () => {
    if (!currentUser()) return toast(t('toast.admin_only'));
    localStorage.removeItem(SESSION_KEY);
    renderAccount();
    renderProfileTab();
    renderStorageAccess();
    toast(t('toast.logged_out'));
});

// Удаление аккаунта
document.getElementById('st-delete-acc').addEventListener('click', () => {
    const u = currentUser();
    if (!u) return toast(t('toast.admin_only'));
    if (!confirm(t('sttng.delete_confirm', { name: u.user }))) return;
    saveUsers(getUsers().filter(x => x.user !== u.user));
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('mf_likes_' + u.user.toLowerCase());
    renderAccount();
    renderProfileTab();
    renderStorageAccess();
    toast(t('toast.deleted'));
});

renderAccount();

// ================= Language: 4 языка =================

function renderLangTab() {
    document.querySelectorAll('[data-lang-set]').forEach(b =>
        b.classList.toggle('active', b.dataset.langSet === LANG));
}

document.querySelectorAll('[data-lang-set]').forEach(btn => {
    btn.addEventListener('click', () => {
        setLang(btn.dataset.langSet);
        renderLangTab();
        renderRules();          // правила перерисовываем на новом языке
        renderAccount();        // тексты аккаунта тоже
        renderProfileTab();
        toast(t('toast.lang_changed'));
    });
});

renderLangTab();

// ================= Viewer: дефолты просмотрщика =================

const VIEWER_DEFAULTS_KEY = 'mf_viewer_defaults';
const defaults = () => JSON.parse(localStorage.getItem(VIEWER_DEFAULTS_KEY) || '{}');

function renderViewerDefaults() {
    const d = defaults();
    document.getElementById('vd-nopost').checked = !!d.noPost;
    document.getElementById('vd-autorotate').checked = !!d.autorotate;
    document.getElementById('vd-wireframe').checked = !!d.wireframe;
    document.getElementById('vd-normals').checked = !!d.normals;
    document.getElementById('vd-bones').checked = !!d.showBones;
}

document.getElementById('vd-save').addEventListener('click', () => {
    localStorage.setItem(VIEWER_DEFAULTS_KEY, JSON.stringify({
        noPost: document.getElementById('vd-nopost').checked,
        autorotate: document.getElementById('vd-autorotate').checked,
        wireframe: document.getElementById('vd-wireframe').checked,
        normals: document.getElementById('vd-normals').checked,
        showBones: document.getElementById('vd-bones').checked,
    }));
    toast(t('toast.defaults_saved'));
});

renderViewerDefaults();

// ================= Rules: правила сообщества =================

function renderRules() {
    const list = document.getElementById('rules-list');
    list.innerHTML = '';
    (RULES[LANG] || RULES.en).forEach((r, i) => {
        const item = document.createElement('div');
        item.className = 'rule-item glass';
        item.innerHTML = `
            <span class="rule-num">${i + 1}</span>
            <div>
                <div class="rule-title">${r.t.replace(/</g, '&lt;')}</div>
                <div class="rule-desc">${r.d.replace(/</g, '&lt;')}</div>
            </div>`;
        list.appendChild(item);
    });
}
renderRules();

// ================= Storage: опасные кнопки только у админа =================

function readStorage() {
    const req = indexedDB.open('meshfab', 1);
    req.onsuccess = () => {
        const db = req.result;
        const store = db.transaction('models').objectStore('models').getAll();
        store.onsuccess = () => {
            const models = store.result;
            document.getElementById('st-models-count').textContent = models.length;
            const bytes = models.reduce((sum, m) => sum + (m.blob ? m.blob.size : 0), 0);
            document.getElementById('st-bytes').textContent =
                bytes < 1024 * 1024 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';
            document.getElementById('st-users-count').textContent = getUsers().length;
        };
    };
}

// Кто что видит во вкладке Storage:
// гость → «зарегайся», юзер → только статистика, админ → всё
function renderStorageAccess() {
    const u = currentUser();
    document.getElementById('storage-guest').classList.toggle('hidden', !!u);
    document.getElementById('storage-editor').classList.toggle('hidden', !u);
    if (!u) return;
    document.getElementById('storage-admin-zone').classList.toggle('hidden', !isAdmin());
    document.getElementById('storage-admin-hint').classList.toggle('hidden', isAdmin());
    readStorage();
}
renderStorageAccess();

// Удалить все модели — только админ
document.getElementById('st-clear-models').addEventListener('click', () => {
    if (!isAdmin()) return toast(t('toast.admin_only'));
    if (!confirm(t('sttng.confirm_clear'))) return;
    const req = indexedDB.open('meshfab', 1);
    req.onsuccess = () => {
        req.result.transaction('models', 'readwrite').objectStore('models').clear();
        localStorage.removeItem('mf_seeded_v2'); // демо-модели можно засеять заново
        readStorage();
        toast(t('toast.models_cleared'));
    };
});

// Полный сброс — только админ
document.getElementById('st-reset-all').addEventListener('click', () => {
    if (!isAdmin()) return toast(t('toast.admin_only'));
    if (!confirm(t('sttng.confirm_reset'))) return;
    const req = indexedDB.open('meshfab', 1);
    req.onsuccess = () => {
        req.result.transaction('models', 'readwrite').objectStore('models').clear();
        const theme = localStorage.getItem('mf_theme');
        const accent = localStorage.getItem('mf_accent');
        const lang = localStorage.getItem('mf_lang');
        Object.keys(localStorage).filter(k => k.startsWith('mf_')).forEach(k => localStorage.removeItem(k));
        localStorage.setItem('mf_theme', theme);
        localStorage.setItem('mf_accent', accent);
        localStorage.setItem('mf_lang', lang);
        readStorage();
        renderAccount();
        renderProfileTab();
        renderStorageAccess();
        toast(t('toast.reset_done'));
    };
});

// ================= Инициализация =================

applyI18n();
openSection(location.hash ? location.hash.slice(1) : 'personalization');
