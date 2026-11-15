/* ============================================================
   upload.html — выкладывание модели на отдельной странице.
   Файл хранится локально в IndexedDB (как blob), на сервер
   ничего не отправляется. Успех → возврат на index.html#m=<id>.
============================================================ */

const USERS_KEY = 'mf_users';
const SESSION_KEY = 'mf_session';

const getUsers = () => JSON.parse(localStorage.getItem(USERS_KEY) || '[]');

// Кто вошёл
function currentUser() {
    const name = localStorage.getItem(SESSION_KEY);
    if (!name) return null;
    return getUsers().find(u => u.user.toLowerCase() === name.toLowerCase()) || null;
}

// Активен ли бан (timed истекает, permanent/publish — нет)
function banActive(u) {
    const b = u && u.ban;
    if (!b) return null;
    if (b.type === 'timed' && (!b.until || b.until <= Date.now())) return null;
    return b;
}

// Человекочитаемый размер файла
function fileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

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

function dbPut(model) {
    return new Promise((resolve) => {
        const req = db.transaction('models', 'readwrite').objectStore('models').put(model);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
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

let pendingFile = null;
const upInput = document.getElementById('up-file-input');
const upDrop = document.getElementById('up-drop');
const upName = document.getElementById('up-name');

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

// Публикация: собираем модель, сохраняем в IndexedDB, возвращаемся на главную
document.getElementById('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const me = currentUser();
    if (!me) { location.href = 'auth.html?mode=register'; return; }
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

    toast(t('toast.published'));
    // Возврат на главную: хеш #m=<id> заставит index.html сразу открыть модель
    location.href = 'index.html#m=' + id;
});

// ================= Запуск =================

applyI18n();

(async () => {
    db = await openDB(); // хранилище моделей нужно до первой публикации

    const me = currentUser();
    // Гость → сначала аккаунт
    if (!me) {
        location.href = 'auth.html?mode=register';
    } else if (banActive(me) && banActive(me).type === 'publish') {
        // Запрет публикаций: бан типа «publish»
        const ban = banActive(me);
        toast(t('ban.upload_blocked', { r: ban.reason || '—' }));
        setTimeout(() => { location.href = 'index.html'; }, 1200);
    }
})();
