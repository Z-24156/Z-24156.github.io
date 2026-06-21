/* ============================================================
   深夜阅读室 — Application Logic
   IndexedDB storage, admin auth, UI rendering, reader
   ============================================================ */

(function () {
'use strict';

/* ==========================================================
   CONFIG
   ========================================================== */
const DB_NAME = 'novelLibrary';
const DB_VERSION = 1;
const STORE_NAME = 'novels';
const AUTH_HASH_KEY = 'nightreader_admin_hash';
const AUTH_SESSION_KEY = 'nightreader_admin_session';
const READING_POS_PREFIX = 'nightreader_pos_';

/* cover background palette — muted, warm-leaning */
const COVER_COLORS = [
    '#2D4A4A','#3D2B3A','#2E3D4A','#4A3525','#3A2E40',
    '#2A3D3D','#3D2E2A','#2E3540','#40332A','#2A3540',
];

/* ==========================================================
   UTILITY
   ========================================================== */
function $(sel, ctx) { return (ctx || document).querySelector(sel); }
function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }
function genId() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }

function formatDate(iso) {
    const d = new Date(iso);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function formatFileSize(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

async function sha256(message) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function getCoverColor(title) {
    let hash = 0;
    for (let i = 0; i < (title || '').length; i++) hash = ((hash << 5) - hash) + title.charCodeAt(i);
    return COVER_COLORS[Math.abs(hash) % COVER_COLORS.length];
}

/* ==========================================================
   TOAST
   ========================================================== */
function showToast(msg, type) {
    type = type || '';
    const container = document.querySelector('.toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(function () { el.remove(); }, 3000);
}

/* ==========================================================
   INDEXED DB
   ========================================================== */
const DB = {
    _db: null,

    open: function () {
        return new Promise(function (resolve, reject) {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (e) {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('title', 'title', { unique: false });
                    store.createIndex('uploadDate', 'uploadDate', { unique: false });
                }
            };
            req.onsuccess = function (e) {
                DB._db = e.target.result;
                resolve(DB._db);
            };
            req.onerror = function (e) { reject(e.target.error); };
        });
    },

    getAll: function () {
        return new Promise(function (resolve, reject) {
            const tx = DB._db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = function () { resolve(req.result || []); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    },

    get: function (id) {
        return new Promise(function (resolve, reject) {
            const tx = DB._db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    },

    add: function (novel) {
        return new Promise(function (resolve, reject) {
            const tx = DB._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.add(novel);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    },

    update: function (id, changes) {
        return new Promise(function (resolve, reject) {
            const tx = DB._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = function () {
                const novel = getReq.result;
                if (!novel) return reject(new Error('Not found'));
                Object.assign(novel, changes);
                const putReq = store.put(novel);
                putReq.onsuccess = function () { resolve(putReq.result); };
                putReq.onerror = function (e) { reject(e.target.error); };
            };
            getReq.onerror = function (e) { reject(e.target.error); };
        });
    },

    delete: function (id) {
        return new Promise(function (resolve, reject) {
            const tx = DB._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.delete(id);
            req.onsuccess = function () { resolve(); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    },

    incrementReads: function (id) {
        return new Promise(function (resolve, reject) {
            const tx = DB._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = function () {
                const novel = getReq.result;
                if (!novel) return reject(new Error('Not found'));
                novel.readCount = (novel.readCount || 0) + 1;
                const putReq = store.put(novel);
                putReq.onsuccess = function () { resolve(novel); };
                putReq.onerror = function (e) { reject(e.target.error); };
            };
            getReq.onerror = function (e) { reject(e.target.error); };
        });
    },

    incrementDownloads: function (id) {
        return new Promise(function (resolve, reject) {
            const tx = DB._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = function () {
                const novel = getReq.result;
                if (!novel) return reject(new Error('Not found'));
                novel.downloadCount = (novel.downloadCount || 0) + 1;
                const putReq = store.put(novel);
                putReq.onsuccess = function () { resolve(novel); };
                putReq.onerror = function (e) { reject(e.target.error); };
            };
            getReq.onerror = function (e) { reject(e.target.error); };
        });
    }
};

/* ==========================================================
   AUTH
   ========================================================== */
const Auth = {
    _admin: false,

    init: function () {
        if (sessionStorage.getItem(AUTH_SESSION_KEY) === '1') {
            this._admin = true;
        }
    },

    isPasswordSet: function () {
        return !!localStorage.getItem(AUTH_HASH_KEY);
    },

    setPassword: async function (password) {
        const hash = await sha256(password);
        localStorage.setItem(AUTH_HASH_KEY, hash);
    },

    verify: async function (password) {
        const stored = localStorage.getItem(AUTH_HASH_KEY);
        if (!stored) return false;
        return stored === await sha256(password);
    },

    login: function () {
        this._admin = true;
        sessionStorage.setItem(AUTH_SESSION_KEY, '1');
    },

    logout: function () {
        this._admin = false;
        sessionStorage.removeItem(AUTH_SESSION_KEY);
    },

    isAdmin: function () { return this._admin; }
};

/* ==========================================================
   UI STATE
   ========================================================== */
const State = {
    currentView: 'bookshelf',  // 'bookshelf' | 'stats'
    novels: [],
    activeNovelId: null,
};

/* ==========================================================
   UI RENDER
   ========================================================== */
const UI = {
    /* --- navigation --- */
    updateNav: function () {
        var links = $$('.nav-link[data-view]');
        links.forEach(function (l) {
            l.classList.toggle('active', l.dataset.view === State.currentView);
        });
        var lockBtn = $('.nav-link.admin-lock');
        if (lockBtn) {
            lockBtn.classList.toggle('unlocked', Auth.isAdmin());
            lockBtn.innerHTML = Auth.isAdmin()
                ? '🔓 管理员'
                : '🔒 登录';
        }
        // show/hide admin controls
        var adminEls = $$('.admin-only');
        adminEls.forEach(function (el) {
            el.style.display = Auth.isAdmin() ? '' : 'none';
        });
    },

    /* --- main content router --- */
    render: function () {
        UI.updateNav();
        if (State.currentView === 'bookshelf') UI.renderBookshelf();
        else if (State.currentView === 'stats') UI.renderStats();
    },

    /* --- bookshelf --- */
    renderBookshelf: async function () {
        var main = $('.main-content');
        State.novels = await DB.getAll();
        // sort by upload date descending
        State.novels.sort(function (a, b) { return (b.uploadDate || '').localeCompare(a.uploadDate || ''); });

        if (State.novels.length === 0) {
            main.innerHTML =
                '<div class="empty-state">' +
                '<div class="empty-icon">📚</div>' +
                '<h3>书架上还没有书</h3>' +
                '<p>这里暂时空无一物。如果你拥有管理员密码，可以登录后上传第一本小说，点亮这间深夜书房。</p>' +
                '</div>';
            return;
        }

        var html = '<div class="bookshelf-grid">';
        State.novels.forEach(function (novel) {
            var coverColor = getCoverColor(novel.title);
            var coverHTML = novel.coverDataUrl
                ? '<img src="' + novel.coverDataUrl + '" alt="封面" loading="lazy">'
                : '<span class="cover-char">' + (novel.title || '?')[0] + '</span>';

            html +=
                '<div class="novel-card" data-id="' + novel.id + '" style="--cover-color:' + coverColor + '">' +
                '<div class="card-cover" style="background:' + coverColor + ';">' + coverHTML + '</div>' +
                '<div class="card-body">' +
                '<div class="card-title">' + escapeHTML(novel.title) + '</div>' +
                '<div class="card-author">' + escapeHTML(novel.author || '佚名') + '</div>' +
                '<div class="card-stats">' +
                '<span>👁 ' + (novel.readCount || 0) + '</span>' +
                '<span>⬇ ' + (novel.downloadCount || 0) + '</span>' +
                '</div>' +
                '</div>';

            if (Auth.isAdmin()) {
                html +=
                    '<div class="admin-badge">' +
                    '<button class="edit-btn" data-id="' + novel.id + '" title="编辑">✎</button>' +
                    '<button class="delete-btn" data-id="' + novel.id + '" title="删除">✕</button>' +
                    '</div>';
            }

            html += '</div>';
        });
        html += '</div>';

        if (Auth.isAdmin()) {
            html +=
                '<div style="text-align:center;padding-bottom:40px;">' +
                '<button class="btn btn-secondary" id="btn-upload-inline">+ 上传新小说</button>' +
                '</div>';
        }

        main.innerHTML = html;
        UI.bindBookshelfEvents();
    },

    bindBookshelfEvents: function () {
        // click card → open detail
        $$('.novel-card').forEach(function (card) {
            card.addEventListener('click', function (e) {
                if (e.target.closest('.admin-badge') || e.target.closest('button')) return;
                var id = card.dataset.id;
                if (id) UI.openDetail(id);
            });
        });
        // edit buttons
        $$('.edit-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                UI.openEditModal(btn.dataset.id);
            });
        });
        // delete buttons
        $$('.delete-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                UI.confirmDelete(btn.dataset.id);
            });
        });
        // upload button
        var uploadBtn = $('#btn-upload-inline');
        if (uploadBtn) {
            uploadBtn.addEventListener('click', function () { UI.openUploadModal(); });
        }
    },

    /* --- stats view --- */
    renderStats: async function () {
        var main = $('.main-content');
        var novels = await DB.getAll();
        State.novels = novels;

        if (novels.length === 0) {
            main.innerHTML =
                '<div class="empty-state">' +
                '<div class="empty-icon">📊</div>' +
                '<h3>暂无统计数据</h3>' +
                '<p>上传小说后，这里会展示阅读量和下载量统计。</p>' +
                '</div>';
            return;
        }

        var totalReads = novels.reduce(function (s, n) { return s + (n.readCount || 0); }, 0);
        var totalDownloads = novels.reduce(function (s, n) { return s + (n.downloadCount || 0); }, 0);
        var totalFiles = novels.length;

        var html = '<div class="stats-dashboard">';
        html += '<div class="stats-header"><h2>📊 数据统计</h2><p>所有小说的阅读与下载数据概览</p></div>';

        html += '<div class="stats-summary">';
        html += '<div class="stat-card"><div class="stat-value">' + totalFiles + '</div><div class="stat-label">藏书数量</div></div>';
        html += '<div class="stat-card"><div class="stat-value">' + totalReads + '</div><div class="stat-label">总阅读量</div></div>';
        html += '<div class="stat-card"><div class="stat-value">' + totalDownloads + '</div><div class="stat-label">总下载量</div></div>';
        html += '<div class="stat-card"><div class="stat-value">' + (totalFiles ? Math.round(totalReads / totalFiles) : 0) + '</div><div class="stat-label">平均阅读量</div></div>';
        html += '</div>';

        // table sorted by reads descending
        var sorted = novels.slice().sort(function (a, b) { return (b.readCount || 0) - (a.readCount || 0); });

        html += '<div class="stats-table-wrap"><table class="stats-table"><thead><tr>';
        html += '<th>#</th><th>书名</th><th>作者</th><th>格式</th><th>阅读量</th><th>下载量</th><th>上传日期</th>';
        html += '</tr></thead><tbody>';

        sorted.forEach(function (n, i) {
            html += '<tr>';
            html += '<td class="rank-num">' + (i + 1) + '</td>';
            html += '<td>' + escapeHTML(n.title) + '</td>';
            html += '<td>' + escapeHTML(n.author || '—') + '</td>';
            html += '<td>' + (n.fileType || '—').toUpperCase() + '</td>';
            html += '<td>' + (n.readCount || 0) + '</td>';
            html += '<td>' + (n.downloadCount || 0) + '</td>';
            html += '<td>' + formatDate(n.uploadDate) + '</td>';
            html += '</tr>';
        });

        html += '</tbody></table></div></div>';
        main.innerHTML = html;
    },

    /* --- novel detail panel --- */
    openDetail: async function (id) {
        var novel = await DB.get(id);
        if (!novel) return;
        State.activeNovelId = id;

        var coverColor = getCoverColor(novel.title);
        var coverHTML = novel.coverDataUrl
            ? '<img src="' + novel.coverDataUrl + '" alt="封面">'
            : '<span class="cover-char">' + (novel.title || '?')[0] + '</span>';

        var overlay = document.createElement('div');
        overlay.className = 'detail-overlay';
        overlay.innerHTML =
            '<div class="detail-panel">' +
            '<button class="detail-close">✕</button>' +
            '<div class="detail-cover" style="background:' + coverColor + ';">' + coverHTML + '</div>' +
            '<div class="detail-body">' +
            '<h2>' + escapeHTML(novel.title) + '</h2>' +
            '<div class="detail-author">' + escapeHTML(novel.author || '佚名') + '</div>' +
            (novel.description ? '<div class="detail-desc">' + escapeHTML(novel.description) + '</div>' : '') +
            '<div class="detail-meta">' +
            '<div class="meta-item"><span class="meta-value">' + (novel.readCount || 0) + '</span><span class="meta-label">阅读量</span></div>' +
            '<div class="meta-item"><span class="meta-value">' + (novel.downloadCount || 0) + '</span><span class="meta-label">下载量</span></div>' +
            '<div class="meta-item"><span class="meta-value">' + (novel.fileType || '—').toUpperCase() + '</span><span class="meta-label">格式</span></div>' +
            '<div class="meta-item"><span class="meta-value">' + formatFileSize(novel.fileSize) + '</span><span class="meta-label">大小</span></div>' +
            '</div>' +
            '<div class="detail-actions">' +
            (novel.fileType === 'txt' ? '<button class="btn btn-primary" id="btn-read">📖 在线阅读</button>' : '') +
            '<button class="btn btn-secondary" id="btn-download">⬇ 下载</button>' +
            (Auth.isAdmin() ? '<button class="btn btn-secondary" id="btn-edit-detail">✎ 编辑</button>' : '') +
            '</div>' +
            '</div>' +
            '</div>';

        document.body.appendChild(overlay);

        overlay.querySelector('.detail-close').addEventListener('click', function () { overlay.remove(); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

        var btnRead = overlay.querySelector('#btn-read');
        if (btnRead) {
            btnRead.addEventListener('click', function () {
                overlay.remove();
                UI.openReader(novel);
            });
        }

        overlay.querySelector('#btn-download').addEventListener('click', function () {
            UI.downloadNovel(novel);
        });

        var btnEditDetail = overlay.querySelector('#btn-edit-detail');
        if (btnEditDetail) {
            btnEditDetail.addEventListener('click', function () {
                overlay.remove();
                UI.openEditModal(id);
            });
        }
    },

    /* --- reader --- */
    openReader: async function (novel) {
        // increment read count
        await DB.incrementReads(novel.id);
        // update in-memory
        novel.readCount = (novel.readCount || 0) + 1;

        // decode file data to text
        var text = '';
        try {
            var decoder = new TextDecoder('utf-8');
            text = decoder.decode(new Uint8Array(novel.fileData));
        } catch (e) {
            text = '[无法解码文件内容]';
        }

        var overlay = document.createElement('div');
        overlay.className = 'reader-overlay';
        overlay.innerHTML =
            '<div class="reader-toolbar">' +
            '<span class="reader-title">📖 ' + escapeHTML(novel.title) + '</span>' +
            '<div class="reader-actions">' +
            '<button class="btn btn-sm btn-secondary" id="reader-download">⬇ 下载</button>' +
            '<button class="btn btn-sm btn-secondary" id="reader-close">✕ 关闭</button>' +
            '</div>' +
            '</div>' +
            '<div class="reader-progress"><div class="reader-progress-bar" id="reader-progress-bar" style="width:0%"></div></div>' +
            '<div class="reader-content" id="reader-scroll"><div class="reader-text">' + escapeHTML(text) + '</div></div>' +
            '<div class="reader-pos-indicator" id="reader-pos">0%</div>';

        document.body.appendChild(overlay);

        var scrollEl = overlay.querySelector('#reader-scroll');
        var progressBar = overlay.querySelector('#reader-progress-bar');
        var posIndicator = overlay.querySelector('#reader-pos');

        // restore reading position
        var savedPos = localStorage.getItem(READING_POS_PREFIX + novel.id);
        if (savedPos) {
            var pct = parseFloat(savedPos);
            if (pct > 0) {
                scrollEl.scrollTop = (scrollEl.scrollHeight - scrollEl.clientHeight) * (pct / 100);
            }
        }

        var updateProgress = function () {
            var maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
            var pct = maxScroll > 0 ? Math.round((scrollEl.scrollTop / maxScroll) * 100) : 0;
            progressBar.style.width = pct + '%';
            posIndicator.textContent = pct + '%';
            localStorage.setItem(READING_POS_PREFIX + novel.id, String(pct));
        };

        scrollEl.addEventListener('scroll', updateProgress);
        updateProgress();

        overlay.querySelector('#reader-close').addEventListener('click', function () { overlay.remove(); });
        overlay.querySelector('#reader-download').addEventListener('click', function () { UI.downloadNovel(novel); });

        // keyboard: Esc to close
        var onKey = function (e) { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
    },

    /* --- download --- */
    downloadNovel: async function (novel) {
        var blob = new Blob([novel.fileData], { type: 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = novel.fileName || (novel.title + '.' + (novel.fileType || 'txt'));
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        await DB.incrementDownloads(novel.id);
        novel.downloadCount = (novel.downloadCount || 0) + 1;
        showToast('下载开始 — ' + novel.title, 'success');
    },

    /* ==========================================================
       ADMIN MODALS
       ========================================================== */

    /* --- login / setup modal --- */
    openLoginModal: function () {
        var isSet = Auth.isPasswordSet();
        var title = isSet ? '管理员登录' : '设置管理员密码';
        var desc = isSet ? '请输入管理员密码以解锁管理功能。' : '首次使用，请设置管理员密码。后续只有知道密码的人才能上传和管理小说。';

        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modal-login';
        overlay.innerHTML =
            '<div class="modal">' +
            '<div class="modal-header"><h3>' + title + '</h3><button class="modal-close">✕</button></div>' +
            '<div class="modal-body">' +
            '<p style="color:var(--text-dim);font-size:0.85rem;margin-bottom:16px;">' + desc + '</p>' +
            '<div class="form-group">' +
            '<label>密码</label>' +
            '<input type="password" id="login-password" placeholder="请输入密码" autocomplete="off">' +
            '</div>' +
            (!isSet ? '<div class="form-group">' +
            '<label>确认密码</label>' +
            '<input type="password" id="login-password-confirm" placeholder="再次输入密码" autocomplete="off">' +
            '</div>' : '') +
            '<div class="form-actions">' +
            '<button class="btn btn-secondary modal-close-btn">取消</button>' +
            '<button class="btn btn-primary" id="btn-login-submit">' + (isSet ? '登录' : '设置密码') + '</button>' +
            '</div>' +
            '</div></div>';

        document.body.appendChild(overlay);

        var closeModal = function () { overlay.remove(); };
        overlay.querySelector('.modal-close').addEventListener('click', closeModal);
        overlay.querySelector('.modal-close-btn').addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

        overlay.querySelector('#btn-login-submit').addEventListener('click', async function () {
            var pw = overlay.querySelector('#login-password').value.trim();
            if (!pw) { showToast('请输入密码', 'error'); return; }

            if (!isSet) {
                var pwConfirm = overlay.querySelector('#login-password-confirm').value.trim();
                if (pw !== pwConfirm) { showToast('两次密码不一致', 'error'); return; }
                if (pw.length < 3) { showToast('密码至少3位', 'error'); return; }
                await Auth.setPassword(pw);
                Auth.login();
                closeModal();
                UI.render();
                showToast('管理员密码已设置，已解锁管理功能', 'success');
                return;
            }

            var ok = await Auth.verify(pw);
            if (!ok) { showToast('密码错误', 'error'); return; }
            Auth.login();
            closeModal();
            UI.render();
            showToast('已解锁管理功能', 'success');
        });

        // focus input
        setTimeout(function () {
            var inp = overlay.querySelector('#login-password');
            if (inp) inp.focus();
        }, 100);
    },

    /* --- upload modal --- */
    openUploadModal: function (editId) {
        var isEdit = !!editId;
        var title = isEdit ? '编辑小说' : '上传新小说';

        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modal-upload';
        overlay.innerHTML =
            '<div class="modal" style="max-width:520px;">' +
            '<div class="modal-header"><h3>' + title + '</h3><button class="modal-close">✕</button></div>' +
            '<div class="modal-body">' +
            '<div class="form-group">' +
            '<label>书名 *</label>' +
            '<input type="text" id="upload-title" placeholder="输入小说书名">' +
            '</div>' +
            '<div class="form-group">' +
            '<label>作者</label>' +
            '<input type="text" id="upload-author" placeholder="输入作者名">' +
            '</div>' +
            '<div class="form-group">' +
            '<label>简介</label>' +
            '<textarea id="upload-desc" placeholder="简短描述这本书..."></textarea>' +
            '</div>' +
            '<div class="form-group">' +
            '<label>封面图片（可选）</label>' +
            '<div class="file-input-wrap">' +
            '<input type="file" id="upload-cover" accept="image/*">' +
            '<div class="file-placeholder">🖼 点击选择封面图片（jpg/png）</div>' +
            '</div>' +
            '</div>' +
            '<div class="form-group">' +
            '<label>' + (isEdit ? '替换文件（可选）' : '小说文件 *') + '</label>' +
            '<div class="file-input-wrap">' +
            '<input type="file" id="upload-file" accept=".txt,.epub,.pdf">' +
            '<div class="file-placeholder">📄 点击选择小说文件（txt/epub/pdf）</div>' +
            '</div>' +
            '<div class="hint">支持 TXT 在线阅读，其他格式仅供下载。建议 TXT 使用 UTF-8 编码。</div>' +
            '</div>' +
            '<div class="form-actions">' +
            '<button class="btn btn-secondary modal-close-btn">取消</button>' +
            '<button class="btn btn-primary" id="btn-upload-submit">' + (isEdit ? '保存修改' : '上传') + '</button>' +
            '</div>' +
            '</div></div>';

        document.body.appendChild(overlay);

        var closeModal = function () { overlay.remove(); };
        overlay.querySelector('.modal-close').addEventListener('click', closeModal);
        overlay.querySelector('.modal-close-btn').addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

        // if editing, pre-fill
        if (isEdit) {
            DB.get(editId).then(function (novel) {
                if (!novel) return;
                overlay.querySelector('#upload-title').value = novel.title || '';
                overlay.querySelector('#upload-author').value = novel.author || '';
                overlay.querySelector('#upload-desc').value = novel.description || '';
            });
        }

        overlay.querySelector('#btn-upload-submit').addEventListener('click', async function () {
            var titleVal = overlay.querySelector('#upload-title').value.trim();
            var authorVal = overlay.querySelector('#upload-author').value.trim();
            var descVal = overlay.querySelector('#upload-desc').value.trim();
            var coverFile = (overlay.querySelector('#upload-cover').files || [])[0];
            var novelFile = (overlay.querySelector('#upload-file').files || [])[0];

            if (!titleVal) { showToast('请输入书名', 'error'); return; }

            if (!isEdit && !novelFile) { showToast('请选择小说文件', 'error'); return; }

            // read file(s)
            var coverDataUrl = null;
            var fileData = null;
            var fileName = '';
            var fileType = '';
            var fileSize = 0;

            try {
                if (isEdit) {
                    var existing = await DB.get(editId);
                    if (existing) {
                        coverDataUrl = existing.coverDataUrl || null;
                        fileData = existing.fileData || null;
                        fileName = existing.fileName || '';
                        fileType = existing.fileType || '';
                        fileSize = existing.fileSize || 0;
                    }
                }
                if (coverFile) {
                    coverDataUrl = await readAsDataURL(coverFile);
                }
                if (novelFile) {
                    fileData = await readAsArrayBuffer(novelFile);
                    fileName = novelFile.name;
                    fileType = getFileExtension(novelFile.name);
                    fileSize = novelFile.size;
                }
            } catch (e) {
                showToast('文件读取失败: ' + e.message, 'error');
                return;
            }

            if (!isEdit && !fileData) { showToast('文件数据为空', 'error'); return; }

            if (isEdit) {
                var updates = {
                    title: titleVal,
                    author: authorVal,
                    description: descVal,
                    coverDataUrl: coverDataUrl,
                };
                if (fileData) {
                    updates.fileData = fileData;
                    updates.fileName = fileName;
                    updates.fileType = fileType;
                    updates.fileSize = fileSize;
                }
                await DB.update(editId, updates);
                closeModal();
                UI.render();
                showToast('「' + titleVal + '」已更新', 'success');
            } else {
                var novel = {
                    id: genId(),
                    title: titleVal,
                    author: authorVal,
                    description: descVal,
                    coverDataUrl: coverDataUrl,
                    fileName: fileName,
                    fileType: fileType,
                    fileSize: fileSize,
                    fileData: fileData,
                    uploadDate: new Date().toISOString(),
                    readCount: 0,
                    downloadCount: 0,
                };
                await DB.add(novel);
                closeModal();
                UI.render();
                showToast('「' + titleVal + '」上传成功！', 'success');
            }
        });
    },

    openEditModal: function (id) {
        UI.openUploadModal(id);
    },

    /* --- confirm delete --- */
    confirmDelete: function (id) {
        DB.get(id).then(function (novel) {
            if (!novel) return;

            var overlay = document.createElement('div');
            overlay.className = 'confirm-overlay';
            overlay.innerHTML =
                '<div class="confirm-dialog">' +
                '<h4>确认删除</h4>' +
                '<p>确定要删除「' + escapeHTML(novel.title) + '」吗？<br>此操作不可恢复，文件数据和统计数据将被永久删除。</p>' +
                '<div class="form-actions">' +
                '<button class="btn btn-secondary" id="confirm-cancel">取消</button>' +
                '<button class="btn btn-danger" id="confirm-delete">确认删除</button>' +
                '</div>' +
                '</div>';

            document.body.appendChild(overlay);

            overlay.querySelector('#confirm-cancel').addEventListener('click', function () { overlay.remove(); });
            overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

            overlay.querySelector('#confirm-delete').addEventListener('click', async function () {
                await DB.delete(id);
                localStorage.removeItem(READING_POS_PREFIX + id);
                overlay.remove();
                UI.render();
                showToast('已删除「' + novel.title + '」', 'success');
            });
        });
    }
};

/* ==========================================================
   HELPERS
   ========================================================== */
function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(new Error('文件读取失败')); };
        reader.readAsArrayBuffer(file);
    });
}

function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(new Error('图片读取失败')); };
        reader.readAsDataURL(file);
    });
}

function getFileExtension(name) {
    var parts = (name || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function escapeHTML(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
}

/* ==========================================================
   APP INIT
   ========================================================== */
async function init() {
    await DB.open();
    Auth.init();

    // nav link clicks (including brand logo)
    $$('.nav-link[data-view], .header-brand[data-view]').forEach(function (link) {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            State.currentView = link.dataset.view;
            UI.render();
        });
    });

    // admin lock button
    var lockBtn = $('.nav-link.admin-lock');
    if (lockBtn) {
        lockBtn.addEventListener('click', function () {
            if (Auth.isAdmin()) {
                Auth.logout();
                UI.render();
                showToast('已退出管理员模式');
            } else {
                UI.openLoginModal();
            }
        });
    }

    // initial render
    UI.render();
}

// DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

})();
