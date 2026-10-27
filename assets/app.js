(function () {
  var root = document.documentElement;

  /* 深浅色切换 */
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  });

  /* 滚动入场 */
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  /* 目录跟随 */
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byHeading = new Map();
    tocLinks.forEach(function (a) {
      var id = decodeURIComponent(a.getAttribute('href').slice(1));
      var heading = document.getElementById(id);
      if (heading) byHeading.set(heading, a);
    });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        tocLinks.forEach(function (a) { a.classList.remove('is-active'); });
        var link = byHeading.get(entry.target);
        if (link) link.classList.add('is-active');
      });
    }, { rootMargin: '-15% 0px -70% 0px' });
    byHeading.forEach(function (_, heading) { spy.observe(heading); });
  }

  /* ============================================================
     答题解锁：答对之后在本地解密，服务器上没有明文
     ============================================================ */
  var gate = document.querySelector('.gate');
  if (!gate) return;

  var out = document.querySelector('.gate-out');
  var form = gate.querySelector('.gate-form');
  var input = gate.querySelector('.gate-input');
  var msg = gate.querySelector('.gate-msg');
  var src = gate.getAttribute('data-src');
  var days = Number(gate.getAttribute('data-days')) || 7;
  var storeKey = 'gate:' + src;

  function b64ToBytes(s) {
    var bin = atob(s);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function bytesToB64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function deriveKey(answer, salt) {
    var base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(answer.trim().toLowerCase()), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: 120000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']
    );
  }

  async function decryptWith(key, payload) {
    // 注意：WebCrypto 的 AES-GCM 没有 tag 参数，认证标签要接在密文后面一起传
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(payload.iv), tagLength: 128 },
      key,
      b64ToBytes(payload.data)
    );
  }

  function render(payload, plain) {
    if (!out) return;
    gate.hidden = true;
    out.hidden = false;
    out.innerHTML = '';

    var isPdf = payload.mime === 'application/pdf';
    var isHtml = payload.mime === 'text/html';
    var blobUrl = URL.createObjectURL(new Blob([plain], { type: payload.mime }));

    // 工具条：新窗口打开 / 下载
    var bar = document.createElement('p');
    bar.className = 'doc-bar';

    var open = document.createElement('a');
    open.className = 'doc-link';
    open.href = blobUrl;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = '在新窗口打开';
    bar.appendChild(open);

    var dl = document.createElement('a');
    dl.className = 'doc-link';
    dl.href = blobUrl;
    dl.download = payload.name;
    dl.textContent = '下载';
    bar.appendChild(dl);
    out.appendChild(bar);

    var viewer = null;
    if (isPdf) {
      viewer = document.createElement('object');
      viewer.type = 'application/pdf';
      viewer.data = blobUrl;
    } else if (isHtml) {
      viewer = document.createElement('iframe');
      viewer.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
      viewer.setAttribute('title', payload.name);
      viewer.srcdoc = new TextDecoder().decode(plain);
    }

    if (viewer) {
      viewer.className = 'doc-viewer';
      out.appendChild(viewer);

      var hint = document.createElement('p');
      hint.className = 'doc-hint';
      hint.textContent = isPdf
        ? '看不全的话，点上面的「在新窗口打开」。'
        : '内容只显示在这一块里；要铺满整屏，点上面的「在新窗口打开」。';
      out.appendChild(hint);
    }
  }

  function remember(key) {
    try {
      crypto.subtle.exportKey('raw', key).then(function (raw) {
        localStorage.setItem(storeKey, JSON.stringify({ k: bytesToB64(raw), exp: Date.now() + days * 864e5 }));
      });
    } catch (e) {}
  }

  if (!window.crypto || !crypto.subtle) {
    if (msg) msg.textContent = '这个浏览器不支持在线解密，换一个浏览器试试。';
    return;
  }

  var cache = null;
  function load() {
    if (!cache) {
      cache = fetch(src).then(function (r) {
        if (!r.ok) throw new Error('load failed');
        return r.json();
      });
    }
    return cache;
  }

  async function unlock(answer, quiet) {
    var payload = await load();
    var key = await deriveKey(answer, b64ToBytes(payload.salt));
    var plain = await decryptWith(key, payload);
    remember(key);
    render(payload, plain);
    return true;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    msg.textContent = '正在打开…';
    msg.classList.remove('is-error');
    try {
      await unlock(input.value, false);
    } catch (err) {
      msg.textContent = '不对。';
      msg.classList.add('is-error');
      input.select();
    }
  });

  /* 七天之内来过就直接打开 */
  try {
    var saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
    if (saved && saved.exp > Date.now()) {
      msg.textContent = '正在打开…';
      load()
        .then(function (payload) {
          return crypto.subtle.importKey('raw', b64ToBytes(saved.k), { name: 'AES-GCM' }, false, ['decrypt'])
            .then(function (key) { return decryptWith(key, payload); })
            .then(function (plain) { render(payload, plain); });
        })
        .catch(function () {
          msg.textContent = '';
          try { localStorage.removeItem(storeKey); } catch (e) {}
        });
    } else if (saved) {
      try { localStorage.removeItem(storeKey); } catch (e) {}
    }
  } catch (e) {}
})();
