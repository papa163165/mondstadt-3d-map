/*!
 * Mondstadt 3D Map - floating window front end
 * Hosts the Cesium map page in a fixed full screen panel driven by a draggable
 * floating ball. Designed for SillyTavern: injected into the parent window,
 * pure DOM, prefixed classes, no Shadow DOM, no relay layer.
 *
 * Public API (on the host window): window.MondstadtMap
 * Events (on the host window): mdsk:ready mdsk:error mdsk:pick mdsk:place
 *                              mdsk:camera mdsk:open mdsk:close
 */
(function () {
    'use strict';

    /* ===================== 1. mount point ===================== */

    var HOST = (function () {
        try {
            if (window.parent && window.parent !== window && window.parent.document && window.parent.document.body) return window.parent;
        } catch (e) { /* cross origin */ }
        try {
            if (window.top && window.top !== window && window.top.document && window.top.document.body) return window.top;
        } catch (e2) { /* cross origin */ }
        return window;
    })();

    var doc = HOST.document;

    if (HOST.__MDSK_FLOAT_WINDOW__) return;
    HOST.__MDSK_FLOAT_WINDOW__ = true;

    /* ===================== 2. config ===================== */

    /* Resolve this script's own CDN base so the map page always ships from the
     * same ref (tag/SHA/branch) the loader was pinned to. A hardcoded ref here
     * meant the script could be loaded from @v2.0.1 while every map asset came
     * from a stale @main. */

    var SELF_URL = (function () {
        try {
            var entries = performance.getEntriesByType('resource') || [];
            for (var i = entries.length - 1; i >= 0; i--) {
                var n = (entries[i] && entries[i].name) || '';
                if (n.indexOf('map-float-window.js') >= 0 && n.indexOf('/mondstadt-3d-map') >= 0) return n;
            }
        } catch (e) { /* ignore */ }
        return null;
    })();

    var SELF_BASE = (function () {
        if (!SELF_URL) return null;
        var clean = SELF_URL.split('#')[0].split('?')[0];
        var idx = clean.indexOf('/scripts/map-float-window.js');
        if (idx < 0) return null;
        return clean.slice(0, idx + 1);
    })();

    var CONFIG = {
        version: '2',
        cdnBase: SELF_BASE || 'https://cdn.jsdelivr.net/gh/papa163165/mondstadt-3d-map@v2.0.1/',
        mapFile: 'index.html',
        easyQuery: 'embed=1',
        readyTimeoutMs: 70000,
        storagePrefix: 'mdsk:',
        defaultBall: { top: '15%', right: '20px' }
    };

    function readGlobal(name) {
        try { if (HOST && HOST[name] != null) return HOST[name]; } catch (e) { /* ignore */ }
        try { if (window[name] != null) return window[name]; } catch (e2) { /* ignore */ }
        return null;
    }

    try {
        var userCfg = readGlobal('__MONDSTADT_MAP_CONFIG__');
        if (userCfg && typeof userCfg === 'object') {
            for (var k in userCfg) {
                if (Object.prototype.hasOwnProperty.call(userCfg, k)) CONFIG[k] = userCfg[k];
            }
        }
    } catch (e) { /* ignore */ }

    /* ===================== 3. state ===================== */

    var panelOpen = false;
    var mapReady = false;
    var readyTimer = null;
    var frame = null;
    var frameToken = 0;
    var blobUrl = null;
    var mapDocUrl = null;
    var lastPick = null;
    var overlayMode = 'idle';
    var ballEl = null;
    var panelEl = null;
    var stageEl = null;
    var overlayEl = null;
    var ovTitleEl = null;
    var ovSubEl = null;
    var statusEl = null;
    var toastEl = null;
    var toastTimer = null;

    /* ===================== 4. storage ===================== */

    function lsGet(key) {
        try { return HOST.localStorage.getItem(CONFIG.storagePrefix + key); } catch (e) { return null; }
    }

    function lsSet(key, value) {
        try { HOST.localStorage.setItem(CONFIG.storagePrefix + key, value); } catch (e) { /* ignore */ }
    }

    function saveOpen(on) { lsSet('open', on ? '1' : '0'); }

    function saveBallPos(pos) {
        try { lsSet('ballPos', JSON.stringify(pos)); } catch (e) { /* ignore */ }
    }

    function loadBallPos() {
        try {
            var raw = lsGet('ballPos');
            if (!raw) return null;
            var p = JSON.parse(raw);
            if (p && typeof p.left === 'number' && typeof p.top === 'number') return p;
        } catch (e) { /* ignore */ }
        return null;
    }

    /* ===================== 5. helpers ===================== */

    function getMapUrl() {
        var override = readGlobal('MDSK_MAP_URL');
        if (override) return String(override);
        var base = CONFIG.cdnBase;
        var baseOverride = readGlobal('MDSK_MAP_BASE');
        if (baseOverride) base = String(baseOverride);
        if (base.charAt(base.length - 1) !== '/') base += '/';
        var q = CONFIG.easyQuery ? ('?' + CONFIG.easyQuery + '&') : '?';
        return base + CONFIG.mapFile + q + 'v=' + encodeURIComponent(CONFIG.version);
    }

    function el(tag, cls, text) {
        var node = doc.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    function clearNode(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    function fire(name, detail) {
        try {
            HOST.dispatchEvent(new HOST.CustomEvent(name, { detail: detail }));
        } catch (e) {
            try {
                var ev = doc.createEvent('CustomEvent');
                ev.initCustomEvent(name, false, false, detail);
                HOST.dispatchEvent(ev);
            } catch (e2) { /* ignore */ }
        }
    }

    function postToMap(msg) {
        try {
            if (!frame || !frame.contentWindow) return false;
            frame.contentWindow.postMessage(msg, '*');
            return true;
        } catch (e) {
            return false;
        }
    }

    function setStatus(text) {
        if (statusEl) statusEl.textContent = text;
    }

    function setBallState(state) {
        if (ballEl) ballEl.setAttribute('data-state', state);
    }

    /* ===================== 6. css ===================== */

    var CSS = [
        '#mdsk-ball{position:fixed;top:15%;right:20px;z-index:999999;width:46px;height:46px;',
        'border-radius:50%;cursor:grab;box-sizing:border-box;display:flex;align-items:center;',
        'justify-content:center;font-size:21px;line-height:1;color:#fff;padding:0;border:1px solid rgba(255,255,255,.22);',
        'background:radial-gradient(circle at 35% 28%,#5b7bff 0%,#1d2f7a 62%,#0a1030 100%);',
        'box-shadow:0 0 0 2px rgba(255,255,255,.10),0 6px 18px rgba(0,0,0,.55),0 0 18px rgba(91,123,255,.45);',
        'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;user-select:none;-webkit-user-select:none;',
        'touch-action:none;transition:transform .15s ease,box-shadow .2s ease;}',
        '#mdsk-ball:hover{transform:scale(1.06);box-shadow:0 0 0 2px rgba(255,255,255,.16),0 8px 22px rgba(0,0,0,.6),0 0 24px rgba(91,123,255,.7);}',
        '#mdsk-ball.mdsk-dragging{cursor:grabbing;transition:none;}',
        '#mdsk-ball>.mdsk-face{pointer-events:none;}',
        '#mdsk-ball>.mdsk-dot{position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border-radius:50%;',
        'background:#8b93a7;box-shadow:0 0 0 2px #0a1030;}',
        '#mdsk-ball[data-state="loading"]>.mdsk-dot{background:#ffb020;animation:mdsk-pulse 1.1s ease-in-out infinite;}',
        '#mdsk-ball[data-state="ready"]>.mdsk-dot{background:#22c55e;}',
        '#mdsk-ball[data-state="error"]>.mdsk-dot{background:#ef4444;}',
        '@keyframes mdsk-pulse{0%,100%{opacity:1}50%{opacity:.3}}',

        '#mdsk-panel{position:fixed;top:0;left:0;width:100vw;height:100vh;height:100dvh;',
        'z-index:999999999;display:none;align-items:center;justify-content:center;',
        'background:rgba(5,5,12,.72);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);',
        'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
        '#mdsk-panel.mdsk-visible{display:flex;}',
        '#mdsk-panel *{box-sizing:border-box;}',
        '#mdsk-panel .mdsk-inner{position:relative;width:96vw;height:94vh;height:94dvh;max-width:1820px;',
        'background:#05070f;border:1px solid rgba(255,255,255,.14);border-radius:14px;overflow:hidden;',
        'display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.78);}',
        '#mdsk-panel .mdsk-bar{display:flex;align-items:center;gap:10px;flex:0 0 auto;padding:8px 12px;',
        'background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,.03));',
        'border-bottom:1px solid rgba(255,255,255,.10);color:#e8ecff;font-size:14px;}',
        '#mdsk-panel .mdsk-title{font-weight:600;letter-spacing:.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '#mdsk-panel .mdsk-status{margin-left:auto;font-size:12px;color:#a8b0c8;padding:3px 9px;border-radius:10px;',
        'background:rgba(255,255,255,.07);white-space:nowrap;}',
        '#mdsk-panel .mdsk-btn{appearance:none;-webkit-appearance:none;border:1px solid rgba(255,255,255,.18);',
        'background:rgba(255,255,255,.06);color:#e8ecff;width:28px;height:28px;border-radius:8px;cursor:pointer;',
        'font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto;}',
        '#mdsk-panel .mdsk-btn:hover{background:rgba(255,255,255,.18);}',
        '#mdsk-panel .mdsk-stage{position:relative;flex:1 1 auto;min-height:0;background:#000;}',
        '#mdsk-panel .mdsk-frame{position:absolute;top:0;left:0;width:100%;height:100%;border:0;display:block;background:#000;}',
        '#mdsk-panel .mdsk-overlay{position:absolute;top:0;left:0;right:0;bottom:0;z-index:5;display:flex;',
        'flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px;',
        'color:#dfe6ff;background:radial-gradient(circle at 50% 40%,rgba(28,42,104,.94),rgba(5,7,15,.97));}',
        '#mdsk-panel .mdsk-overlay[hidden]{display:none;}',
        '#mdsk-panel .mdsk-spinner{width:42px;height:42px;border-radius:50%;border:3px solid rgba(255,255,255,.18);',
        'border-top-color:#6b8cff;animation:mdsk-spin 1s linear infinite;}',
        '@keyframes mdsk-spin{to{transform:rotate(360deg)}}',
        '#mdsk-panel .mdsk-ov-title{font-size:16px;font-weight:600;}',
        '#mdsk-panel .mdsk-ov-sub{font-size:13px;color:#9aa4c0;max-width:560px;line-height:1.6;word-break:break-word;}',
        '#mdsk-panel .mdsk-retry{display:none;margin-top:2px;padding:8px 18px;border-radius:10px;',
        'border:1px solid rgba(255,255,255,.22);background:#2a3f9e;color:#fff;cursor:pointer;font-size:13px;}',
        '#mdsk-panel .mdsk-retry:hover{background:#3752c4;}',
        '#mdsk-panel .mdsk-overlay.mdsk-is-error .mdsk-spinner{display:none;}',
        '#mdsk-panel .mdsk-overlay.mdsk-is-error .mdsk-retry{display:inline-block;}',

        '#mdsk-toast{position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:1000000000;',
        'background:rgba(10,14,30,.94);color:#e8ecff;border:1px solid rgba(255,255,255,.16);border-radius:10px;',
        'padding:8px 16px;font-size:13px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
        'pointer-events:none;opacity:0;transition:opacity .2s ease;max-width:80vw;}',
        '#mdsk-toast.mdsk-show{opacity:1;}'
    ].join('');

    /* ===================== 7. dom ===================== */

    function removePrevious() {
        ['mdsk-style', 'mdsk-ball', 'mdsk-panel', 'mdsk-toast'].forEach(function (id) {
            var old = doc.getElementById(id);
            if (old && old.parentNode) old.parentNode.removeChild(old);
        });
    }

    function buildStyle() {
        var style = doc.createElement('style');
        style.id = 'mdsk-style';
        style.type = 'text/css';
        style.appendChild(doc.createTextNode(CSS));
        (doc.head || doc.documentElement).appendChild(style);
    }

    function pinIcon() {
        var NS = 'http://www.w3.org/2000/svg';
        var svg = doc.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '22');
        svg.setAttribute('height', '22');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        var path = doc.createElementNS(NS, 'path');
        path.setAttribute('fill', 'currentColor');
        path.setAttribute('d', 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z');
        svg.appendChild(path);
        return svg;
    }

    function buildBall() {
        ballEl = doc.createElement('div');
        ballEl.id = 'mdsk-ball';
        ballEl.setAttribute('role', 'button');
        ballEl.setAttribute('tabindex', '0');
        ballEl.setAttribute('aria-label', '打开城市地图');
        ballEl.setAttribute('title', '打开城市地图');
        ballEl.setAttribute('data-state', 'idle');

        var face = el('span', 'mdsk-face');
        face.appendChild(pinIcon());
        var dot = el('span', 'mdsk-dot');
        ballEl.appendChild(face);
        ballEl.appendChild(dot);

        var saved = loadBallPos();
        if (saved) applyBallPos(saved); else applyBallPos(null);

        doc.body.appendChild(ballEl);
    }

    function applyBallPos(pos) {
        if (!ballEl) return;
        var s = ballEl.style;
        if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
            s.left = pos.left + 'px';
            s.top = pos.top + 'px';
            s.right = 'auto';
        } else {
            s.left = 'auto';
            s.top = CONFIG.defaultBall.top;
            s.right = CONFIG.defaultBall.right;
        }
    }

    function clampBall(left, top) {
        var w = HOST.innerWidth || doc.documentElement.clientWidth || 800;
        var h = HOST.innerHeight || doc.documentElement.clientHeight || 600;
        var size = (ballEl && ballEl.offsetWidth) || 46;
        return {
            left: Math.max(2, Math.min(w - size - 2, left)),
            top: Math.max(2, Math.min(h - size - 2, top))
        };
    }

    function buildPanel() {
        panelEl = doc.createElement('div');
        panelEl.id = 'mdsk-panel';
        panelEl.setAttribute('role', 'dialog');
        panelEl.setAttribute('aria-hidden', 'true');

        var inner = el('div', 'mdsk-inner');
        var bar = el('div', 'mdsk-bar');
        var title = el('span', 'mdsk-title', '\u8499\u5FB7\u65AF\u79D1 \u00B7 3D \u57CE\u5E02\u5730\u56FE');
        statusEl = el('span', 'mdsk-status', '\u672A\u8FDE\u63A5');

        var reloadBtn = el('button', 'mdsk-btn', '\u21BB');
        reloadBtn.type = 'button';
        reloadBtn.setAttribute('title', '\u91CD\u65B0\u52A0\u8F7D\u5730\u56FE');
        reloadBtn.setAttribute('aria-label', '\u91CD\u65B0\u52A0\u8F7D\u5730\u56FE');

        var closeBtn = el('button', 'mdsk-btn', '\u2715');
        closeBtn.type = 'button';
        closeBtn.setAttribute('title', '\u5173\u95ED');
        closeBtn.setAttribute('aria-label', '\u5173\u95ED');

        bar.appendChild(title);
        bar.appendChild(statusEl);
        bar.appendChild(reloadBtn);
        bar.appendChild(closeBtn);

        stageEl = el('div', 'mdsk-stage');

        overlayEl = el('div', 'mdsk-overlay');
        var spinner = el('div', 'mdsk-spinner');
        ovTitleEl = el('div', 'mdsk-ov-title', '');
        ovSubEl = el('div', 'mdsk-ov-sub', '');
        var retryBtn = el('button', 'mdsk-retry', '\u91CD\u8BD5');
        retryBtn.type = 'button';
        overlayEl.appendChild(spinner);
        overlayEl.appendChild(ovTitleEl);
        overlayEl.appendChild(ovSubEl);
        overlayEl.appendChild(retryBtn);

        stageEl.appendChild(overlayEl);
        inner.appendChild(bar);
        inner.appendChild(stageEl);
        panelEl.appendChild(inner);
        doc.body.appendChild(panelEl);

        closeBtn.addEventListener('click', function () { closePanel(); });
        reloadBtn.addEventListener('click', function () { reloadMap(); });
        retryBtn.addEventListener('click', function () { reloadMap(); });
        panelEl.addEventListener('mousedown', function (e) {
            if (e.target === panelEl) closePanel();
        });
    }

    function buildToast() {
        toastEl = doc.createElement('div');
        toastEl.id = 'mdsk-toast';
        doc.body.appendChild(toastEl);
    }

    function flashToast(text) {
        if (!toastEl) return;
        toastEl.textContent = text;
        toastEl.classList.add('mdsk-show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            if (toastEl) toastEl.classList.remove('mdsk-show');
        }, 2200);
    }

    /* ===================== 8. loading overlay ===================== */

    function setOverlay(mode, title, sub) {
        overlayMode = mode;
        if (!overlayEl) return;
        overlayEl.hidden = false;
        if (mode === 'error') overlayEl.classList.add('mdsk-is-error');
        else overlayEl.classList.remove('mdsk-is-error');
        ovTitleEl.textContent = title || '';
        ovSubEl.textContent = sub || '';
    }

    function hideOverlay() {
        overlayMode = 'idle';
        if (overlayEl) overlayEl.hidden = true;
    }

    var LOADING_TITLE = '\u6B63\u5728\u52A0\u8F7D\u5730\u56FE\u2026';
    var LOADING_SUB = '\u9996\u6B21\u6253\u5F00\u9700\u8054\u7F51\u4E0B\u8F7D\u4E09\u7EF4\u6570\u636E\uFF0C\u7EA6 30\u201360 \u79D2\uFF0C\u8BF7\u8010\u5FC3\u7B49\u5F85\u3002';

    function probeUrl(url, cb) {
        var f = null;
        try { f = HOST.fetch || window.fetch; } catch (e) { f = null; }
        if (!f) { cb(0); return; }
        try {
            f(url, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
                cb(r.status);
            }).catch(function () {
                try {
                    f(url, { method: 'GET', cache: 'no-store' }).then(function (r) { cb(r.status); })
                        .catch(function () { cb(0); });
                } catch (e2) { cb(0); }
            });
        } catch (e3) { cb(0); }
    }

    function startLoadWatch(url, token) {
        mapReady = false;
        setOverlay('loading', LOADING_TITLE, LOADING_SUB);
        setStatus('\u52A0\u8F7D\u4E2D');
        setBallState('loading');
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = setTimeout(function () {
            if (mapReady || token !== frameToken) return;
            probeUrl(url, function (status) {
                if (mapReady || token !== frameToken) return;
                if (status === 200) {
                    setOverlay('error', '\u5730\u56FE\u52A0\u8F7D\u8D85\u65F6',
                        '\u8D44\u6E90\u53EF\u8BBF\u95EE\uFF0C\u4F46\u4E09\u7EF4\u6570\u636E\u4ECD\u5728\u52A0\u8F7D\uFF08\u6570\u636E\u8F83\u5927\uFF09\u3002\u53EF\u7A0D\u5019\u518D\u770B\uFF0C\u6216\u70B9\u201C\u91CD\u8BD5\u201D\u3002');
                } else if (!status) {
                    setOverlay('error', '\u65E0\u6CD5\u8BBF\u95EE\u5730\u56FE\u8D44\u6E90',
                        '\u8BF7\u6C42\u5730\u56FE\u5730\u5740\u5931\u8D25\uFF08\u7F51\u7EDC\u4E0D\u901A\u3001\u8DE8\u57DF\u62E6\u622A\u6216\u5730\u5740\u4E0D\u5B58\u5728\uFF09\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u70B9\u201C\u91CD\u8BD5\u201D\u3002');
                } else {
                    setOverlay('error', '\u65E0\u6CD5\u8BBF\u95EE\u5730\u56FE\u8D44\u6E90',
                        'CDN \u8FD4\u56DE HTTP ' + status + '\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u70B9\u201C\u91CD\u8BD5\u201D\u3002');
                }
                setStatus('\u9519\u8BEF');
                setBallState('error');
                fire('mdsk:error', { stage: 'timeout', status: status, url: url });
            });
        }, CONFIG.readyTimeoutMs);
    }

    /* ===================== 9. iframe ===================== */

    // jsDelivr / statically.io 这类 CDN 出于防钓鱼策略，会把 .html 按 text/plain 下发，
    // 浏览器拿到后只会把源码当纯文本显示，不会解析成页面。所以不能直接给 iframe 指 URL。
    // 做法：把 index.html 取回来，补一个 <base href="CDN 根"> 让相对路径仍指向 CDN，
    // 再用 Blob URL 塞进 iframe（Blob 不经过 CDN 的内容类型判定）。
    function jsString(s) {
        return JSON.stringify(String(s))
            .replace(/</g, '\\u003c')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    function baseOf(url) {
        return url.replace(/[?#][\s\S]*$/, '').replace(/[^/]*$/, '');
    }

    function queryOf(url) {
        var i = url.indexOf('?');
        if (i < 0) return '';
        var q = url.slice(i);
        var h = q.indexOf('#');
        return h < 0 ? q : q.slice(0, h);
    }

    function buildMapDocument(html, base, query) {
        var inject = '<base href="' + String(base).replace(/"/g, '%22') + '">' +
            '<script>window.__MDSK_EMBED__=true;window.__MDSK_PARAMS__=' + jsString(query) + ';<\/script>';
        var m = /<head[^>]*>/i.exec(html);
        if (m) {
            var at = m.index + m[0].length;
            return html.slice(0, at) + inject + html.slice(at);
        }
        return inject + html;
    }

    function loadMapDocument(frameEl, url, token) {
        var f = null;
        try { f = HOST.fetch || window.fetch; } catch (e) { f = null; }
        if (!f) {
            setOverlay('error', '\u65E0\u6CD5\u52A0\u8F7D\u5730\u56FE', '\u5F53\u524D\u73AF\u5883\u7F3A\u5C11 fetch\uFF0C\u65E0\u6CD5\u53D6\u56DE\u5730\u56FE\u9875\u3002');
            setStatus('\u9519\u8BEF');
            setBallState('error');
            return;
        }
        f(url, { cache: 'no-store' }).then(function (r) {
            if (token !== frameToken) return null;
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
        }).then(function (html) {
            if (token !== frameToken || html == null) return;
            var docHtml = buildMapDocument(html, baseOf(url), queryOf(url));
            var blob = new HOST.Blob([docHtml], { type: 'text/html' });
            blobUrl = HOST.URL.createObjectURL(blob);
            mapDocUrl = url;
            if (token !== frameToken) return;
            frameEl.src = blobUrl;
        }).catch(function (err) {
            if (token !== frameToken) return;
            setOverlay('error', '\u65E0\u6CD5\u52A0\u8F7D\u5730\u56FE\u9875',
                '\u8BF7\u6C42 ' + url + ' \u5931\u8D25\uFF1A' + ((err && err.message) || err) +
                '\u3002\u82E5\u6307\u5411\u672C\u673A\u670D\u52A1\u5668\uFF0C\u8BF7\u786E\u8BA4\u5B83\u4F1A\u8FD4\u56DE ' +
                'Access-Control-Allow-Origin \u54CD\u5E94\u5934\uFF08jsDelivr \u672C\u8EAB\u662F\u5141\u8BB8\u7684\uFF09\u3002');
            setStatus('\u9519\u8BEF');
            setBallState('error');
            fire('mdsk:error', { stage: 'document', message: String((err && err.message) || err), url: url });
        });
    }

    function ensureFrame() {
        if (frame && frame.parentNode) return frame;
        var url = getMapUrl();
        frameToken += 1;
        var token = frameToken;

        frame = doc.createElement('iframe');
        frame.className = 'mdsk-frame';
        frame.id = 'mdsk-frame';
        frame.setAttribute('title', '\u8499\u5FB7\u65AF\u79D1 3D \u5730\u56FE');
        frame.setAttribute('allow', 'fullscreen; clipboard-write');
        frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');

        frame.addEventListener('load', function () {
            if (token !== frameToken || mapReady) return;
            if (overlayMode === 'error') return;
            setOverlay('loading', '\u5730\u56FE\u754C\u9762\u5DF2\u8F7D\u5165\uFF0C\u6B63\u5728\u52A0\u8F7D\u4E09\u7EF4\u6570\u636E\u2026',
                '\u9996\u6B21\u6253\u5F00\u7EA6 30\u201360 \u79D2\uFF0C\u8BF7\u7A0D\u5019\u3002');
        });

        stageEl.appendChild(frame);
        startLoadWatch(url, token);
        loadMapDocument(frame, url, token);
        return frame;
    }

    function destroyFrame() {
        if (frame) {
            try { frame.parentNode && frame.parentNode.removeChild(frame); } catch (e) { /* ignore */ }
        }
        if (blobUrl) {
            try { HOST.URL.revokeObjectURL(blobUrl); } catch (e2) { /* ignore */ }
            blobUrl = null;
        }
        mapDocUrl = null;
        frame = null;
        frameToken += 1;
    }

    function reloadMap() {
        destroyFrame();
        mapReady = false;
        if (readyTimer) clearTimeout(readyTimer);
        setStatus('\u672A\u8FDE\u63A5');
        setBallState('idle');
        if (panelOpen) ensureFrame();
    }

    /* ===================== 10. panel open / close ===================== */

    function openPanel() {
        if (panelOpen) return;
        panelOpen = true;
        ensureFrame();
        panelEl.classList.add('mdsk-visible');
        panelEl.setAttribute('aria-hidden', 'false');
        if (ballEl) ballEl.setAttribute('aria-label', '\u5173\u95ED\u57CE\u5E02\u5730\u56FE');
        saveOpen(true);
        setTimeout(function () { postToMap({ type: 'tw:resize' }); }, 80);
        setTimeout(function () { postToMap({ type: 'tw:resize' }); }, 450);
        fire('mdsk:open', null);
    }

    function closePanel() {
        if (!panelOpen) return;
        panelOpen = false;
        panelEl.classList.remove('mdsk-visible');
        panelEl.setAttribute('aria-hidden', 'true');
        if (ballEl) ballEl.setAttribute('aria-label', '\u6253\u5F00\u57CE\u5E02\u5730\u56FE');
        saveOpen(false);
        fire('mdsk:close', null);
    }

    function togglePanel() {
        if (panelOpen) closePanel(); else openPanel();
    }

    /* ===================== 11. ball interaction ===================== */

    function bindBall() {
        var dragging = false;
        var moved = false;
        var startX = 0;
        var startY = 0;
        var offX = 0;
        var offY = 0;

        function down(e) {
            if (e.type === 'mousedown' && e.button !== 0) return;
            var p = (e.touches && e.touches[0]) || e;
            dragging = true;
            moved = false;
            startX = p.clientX;
            startY = p.clientY;
            var r = ballEl.getBoundingClientRect();
            offX = startX - r.left;
            offY = startY - r.top;
            ballEl.classList.add('mdsk-dragging');
            doc.addEventListener('mousemove', move, true);
            doc.addEventListener('mouseup', up, true);
            doc.addEventListener('touchmove', move, true);
            doc.addEventListener('touchend', up, true);
            doc.addEventListener('touchcancel', up, true);
            if (e.cancelable) e.preventDefault();
        }

        function move(e) {
            if (!dragging) return;
            var p = (e.touches && e.touches[0]) || e;
            if (typeof p.clientX !== 'number') return;
            if (Math.abs(p.clientX - startX) > 4 || Math.abs(p.clientY - startY) > 4) moved = true;
            if (moved) applyBallPos(clampBall(p.clientX - offX, p.clientY - offY));
            if (e.cancelable) e.preventDefault();
        }

        function up() {
            if (!dragging) return;
            dragging = false;
            ballEl.classList.remove('mdsk-dragging');
            doc.removeEventListener('mousemove', move, true);
            doc.removeEventListener('mouseup', up, true);
            doc.removeEventListener('touchmove', move, true);
            doc.removeEventListener('touchend', up, true);
            doc.removeEventListener('touchcancel', up, true);
            if (moved) {
                var r = ballEl.getBoundingClientRect();
                saveBallPos({ left: Math.round(r.left), top: Math.round(r.top) });
            } else {
                togglePanel();
            }
        }

        ballEl.addEventListener('mousedown', down);
        ballEl.addEventListener('touchstart', down, { passive: false });
        ballEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                togglePanel();
            }
        });
    }

    /* ===================== 12. messages from the map ===================== */

    function onMessage(ev) {
        if (!frame || ev.source !== frame.contentWindow) return;
        var d = ev.data;
        if (!d || typeof d !== 'object') return;
        var t = d.type;
        if (typeof t !== 'string' || t.indexOf('tw:') !== 0) return;

        switch (t) {
            case 'tw:ready':
                if (readyTimer) clearTimeout(readyTimer);
                if (d.ok === false) {
                    mapReady = false;
                    // 地图页会先发 tw:error（带具体原因）再发 ok:false 的 tw:ready，
                    // 已经在错误态就不要用笼统文案盖掉更详细的说明。
                    if (overlayMode !== 'error') {
                        setOverlay('error', '\u5730\u56FE\u6570\u636E\u52A0\u8F7D\u5931\u8D25',
                            '\u5730\u56FE\u9875\u5DF2\u6253\u5F00\uFF0C\u4F46\u4E09\u7EF4\u6570\u636E\u672A\u80FD\u8F7D\u5165\u3002\u8BF7\u70B9\u201C\u91CD\u8BD5\u201D\u6216\u68C0\u67E5\u7F51\u7EDC\u3002');
                        setStatus('\u9519\u8BEF');
                        setBallState('error');
                        fire('mdsk:error', d);
                    }
                } else {
                    mapReady = true;
                    hideOverlay();
                    setStatus('\u5DF2\u8FDE\u63A5 v' + (d.version || '?'));
                    setBallState('ready');
                    fire('mdsk:ready', d);
                }
                break;

            case 'tw:error':
                if (readyTimer) clearTimeout(readyTimer);
                mapReady = false;
                setOverlay('error', '\u5730\u56FE\u52A0\u8F7D\u5931\u8D25',
                    String(d.message || '\u672A\u77E5\u9519\u8BEF'));
                setStatus('\u9519\u8BEF');
                setBallState('error');
                fire('mdsk:error', d);
                break;

            case 'tw:pick':
                lastPick = { lon: d.lon, lat: d.lat };
                flashToast('\u5DF2\u53D6\u5750\u6807 ' + d.lon + ', ' + d.lat);
                fire('mdsk:pick', d);
                break;

            case 'tw:place':
                fire('mdsk:place', d);
                break;

            case 'tw:camera':
                fire('mdsk:camera', d);
                break;
        }
    }

    /* ===================== 13. boot ===================== */

    var booted = false;

    function boot() {
        if (booted || !doc.body) return false;
        booted = true;
        removePrevious();
        buildStyle();
        buildBall();
        buildPanel();
        buildToast();
        bindBall();

        HOST.addEventListener('message', onMessage);
        if (HOST !== window) {
            // 本脚本常运行在「酒馆助手脚本 iframe」里。地图页对 tw:getCamera / tw:findPlace
            // 的应答按 postMessage 的 source 回包，而 source 是调用方所在窗口：从本 iframe
            // 发出去的消息，应答会回到本 iframe 而不是宿主页。两个窗口都监听才不会丢包。
            window.addEventListener('message', onMessage);
        }

        doc.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && panelOpen) {
                e.stopPropagation();
                closePanel();
            }
        }, true);

        HOST.addEventListener('resize', function () {
            if (panelOpen) postToMap({ type: 'tw:resize' });
        });

        var saved = loadBallPos();
        if (saved) applyBallPos(clampBall(saved.left, saved.top));

        HOST.MondstadtMap = {
            version: CONFIG.version,
            getMapUrl: getMapUrl,
            open: openPanel,
            close: closePanel,
            toggle: togglePanel,
            isOpen: function () { return panelOpen; },
            isReady: function () { return mapReady; },
            reload: reloadMap,
            send: function (msg) { return postToMap(msg); },
            setCharacters: function (list) { return postToMap({ type: 'tw:setCharacters', list: list }); },
            flyTo: function (lon, lat, height, duration) {
                return postToMap({ type: 'tw:flyTo', lon: lon, lat: lat, height: height, duration: duration });
            },
            getCamera: function (rid) { return postToMap({ type: 'tw:getCamera', rid: rid }); },
            findPlace: function (q, rid, limit) {
                return postToMap({ type: 'tw:findPlace', q: q, rid: rid, limit: limit });
            },
            lastPick: function () { return lastPick; },
            debug: function () {
                var domFrame = doc.getElementById('mdsk-frame');
                return {
                    mountedOn: HOST === window ? 'self' : 'parent',
                    frameExists: !!frame,
                    frameInDom: !!(frame && frame.parentNode),
                    frameIsDomNode: frame != null && frame === domFrame,
                    frameSrc: frame ? frame.getAttribute('src') : null,
                    domFrameSrc: domFrame ? domFrame.getAttribute('src') : null,
                    mapDocUrl: mapDocUrl,
                    blobUrl: blobUrl,
                    iframeCount: doc.querySelectorAll('iframe').length,
                    panelOpen: panelOpen,
                    mapReady: mapReady,
                    overlayMode: overlayMode,
                    mapUrl: getMapUrl()
                };
            },
            on: function (name, fn) {
                var full = 'mdsk:' + name;
                HOST.addEventListener(full, fn);
                return function () { HOST.removeEventListener(full, fn); };
            }
        };

        if (lsGet('open') === '1') openPanel();
        return true;
    }

    if (!boot()) {
        doc.addEventListener('DOMContentLoaded', function () { boot(); });
        setTimeout(function () { boot(); }, 0);
    }
})();
