(function () {
  'use strict';

  // 诗句：按来源取（内置 / 一言 API / 仓库 motto.txt）
  var mottoEl = document.querySelector('.site-motto');
  var fromEl = document.querySelector('.site-from');
  if (mottoEl) {
    var source = mottoEl.dataset.source || 'builtin';

    var applyMotto = function (text, from) {
      if (!text) return;
      mottoEl.textContent = text;
      if (fromEl && from) fromEl.textContent = from;
    };

    if (source === 'api') {
      var api = mottoEl.dataset.api;
      if (api) {
        fetch(api, { mode: 'cors' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var text = d.hitokoto || d.text || d.motto || '';
            var from = d.from || d.from_who || d.source || '';
            applyMotto(text, from);
          })
          .catch(function () { /* 接口挂了就保留首屏那句 */ });
      }
    } else if (source === 'txt') {
      fetch(mottoEl.dataset.txt || '/motto.txt')
        .then(function (r) { return r.text(); })
        .then(function (txt) {
          var lines = txt.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
          if (!lines.length) return;
          var pick = lines[Math.floor(Math.random() * lines.length)];
          // 格式：句子 —— 出处（破折号后可省，-- 与单个 — 也认）
          var m = pick.match(/^(.*?)\s*(?:——|—|--)\s*(.+)$/);
          if (m) applyMotto(m[1].trim(), m[2].trim());
          else applyMotto(pick, '');
        })
        .catch(function () { /* 文件缺失保留首屏那句 */ });
    } else {
      var list = [];
      try {
        list = JSON.parse(decodeURIComponent(mottoEl.dataset.mottos || '[]'));
      } catch (e) { list = []; }
      if (list.length > 1) {
        var pick = list[Math.floor(Math.random() * list.length)];
        applyMotto(pick.text, pick.from);
      }
    }
  }

  // 滚动后导航栏由透明变实底
  var navbar = document.getElementById('navbar');
  if (navbar) {
    var onScroll = function () {
      navbar.classList.toggle('scrolled', window.scrollY > 60);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // MENU：桌面收起/展开侧栏，移动端滑出抽屉
  var menuBtn = document.getElementById('menuBtn');
  var sidebarMask = document.getElementById('sidebarMask');
  function toggleSidebar() {
    if (window.innerWidth <= 960) {
      document.body.classList.toggle('sidebar-open');
    } else {
      document.body.classList.toggle('sidebar-collapsed');
    }
  }
  function closeSidebar() {
    document.body.classList.remove('sidebar-open');
  }
  if (menuBtn) menuBtn.addEventListener('click', toggleSidebar);
  if (sidebarMask) sidebarMask.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSidebar();
  });

  // 评论（giscus）：文章页才有 .post-comments 容器，其他页面不会加载它的脚本
  var giscusSection = document.querySelector('.post-comments');

  // theme 配置里的 auto = 跟随本站的深浅色开关；其他值原样交给 giscus
  function giscusThemeName() {
    var mode = (giscusSection && giscusSection.dataset.theme) || 'auto';
    if (mode !== 'auto') return mode;
    return document.body.classList.contains('dark') ? 'dark' : 'light';
  }

  // giscus 的 iframe 是 giscus.app 的独立文档（跨域），换主题只能 postMessage
  function syncGiscusTheme() {
    if (!giscusSection) return;
    var frame = giscusSection.querySelector('iframe.giscus-frame');
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(
      { giscus: { setConfig: { theme: giscusThemeName() } } },
      'https://giscus.app'
    );
  }

  function mountGiscus() {
    if (!giscusSection) return;
    var box = giscusSection.querySelector('.giscus');
    if (!box || box.dataset.mounted) return;
    box.dataset.mounted = '1';

    var d = giscusSection.dataset;
    var attrs = {
      repo: d.repo,
      'repo-id': d.repoId,
      category: d.category || '',
      'category-id': d.categoryId,
      mapping: d.mapping || 'pathname',
      strict: d.strict || '0',
      'reactions-enabled': d.reactions || '1',
      'emit-metadata': d.emitMetadata || '0',
      'input-position': d.inputPosition || 'top',
      theme: giscusThemeName(),
      lang: d.lang || 'zh-CN',
      loading: d.loading || 'lazy',
    };

    var script = document.createElement('script');
    script.src = 'https://giscus.app/client.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    Object.keys(attrs).forEach(function (k) {
      script.setAttribute('data-' + k, attrs[k]);
    });

    // giscus 会把 iframe 塞进页面里的 .giscus 容器（并清空其子节点），
    // 所以脚本本身挂到 body，别放进容器里。
    document.body.appendChild(script);

    // iframe 由 giscus 动态插入，出现后再同步一次主题：
    // 首次加载时用户可能已经点过深色开关，而脚本里的 data-theme 是加载那一刻的值。
    if (window.MutationObserver) {
      var obs = new MutationObserver(function () {
        var frame = box.querySelector('iframe.giscus-frame');
        if (!frame) return;
        obs.disconnect();
        frame.addEventListener('load', syncGiscusTheme);
      });
      obs.observe(box, { childList: true });
    }
  }

  // 深色模式
  var themeBtn = document.getElementById('themeBtn');
  var STORAGE_KEY = 'cnblog-theme';

  function applyTheme(dark) {
    document.body.classList.toggle('dark', dark);
    if (themeBtn) themeBtn.textContent = dark ? '☀' : '☾';
    syncGiscusTheme();
  }

  var saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'dark') applyTheme(true);
  else if (saved === 'light') applyTheme(false);
  else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme(true);

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var dark = !document.body.classList.contains('dark');
      applyTheme(dark);
      localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
    });
  }

  // 深浅色确定之后再挂 giscus，脚本里的 data-theme 才是首屏该有的值
  mountGiscus();

  // 浏览量（GoatCounter）：读 count.json 填数字。
  // 404 = 这个路径还没被统计过，按 0 显示；403 = 站点没开公开计数，保持隐藏。
  var viewsEl = document.querySelector('.post-views');
  if (viewsEl && viewsEl.dataset.code) {
    fetch('https://' + viewsEl.dataset.code + '.goatcounter.com/counter/'
      + encodeURIComponent(location.pathname) + '.json',
      { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 404) return { count: '0' };
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        if (!d || d.count == null) return;
        viewsEl.textContent = (viewsEl.dataset.label || '阅读') + ' ' + d.count;
        viewsEl.hidden = false;
      })
      .catch(function () { /* 忽略：广告插件或网络问题 */ });
  }

  // 目录滚动高亮
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc-wrap .toc-link'));
  if (tocLinks.length) {
    var headingMap = {};
    tocLinks.forEach(function (link) {
      var id = decodeURIComponent((link.getAttribute('href') || '').replace(/^#/, ''));
      var el = document.getElementById(id);
      if (el) headingMap[id] = link;
    });

    var current = null;
    function updateActive() {
      var passed = null;
      Object.keys(headingMap).forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 120) passed = id;
      });
      var next = passed ? headingMap[passed] : null;
      if (next === current) return;
      if (current) current.classList.remove('active');
      if (next) {
        next.classList.add('active');
        // 让高亮项在目录里保持可见
        var wrap = next.closest('.toc-wrap');
        if (wrap) {
          var top = next.offsetTop - wrap.clientHeight / 2;
          if (Math.abs(wrap.scrollTop - top) > wrap.clientHeight / 2) wrap.scrollTop = Math.max(0, top);
        }
      }
      current = next;
    }

    window.addEventListener('scroll', updateActive, { passive: true });
    updateActive();

    // 点击平滑滚动，抵消固定导航栏的高度
    tocLinks.forEach(function (link) {
      link.addEventListener('click', function (e) {
        var id = decodeURIComponent((link.getAttribute('href') || '').replace(/^#/, ''));
        var el = document.getElementById(id);
        if (!el) return;
        e.preventDefault();
        window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
        history.replaceState(null, '', '#' + id);
      });
    });
  }
})();
