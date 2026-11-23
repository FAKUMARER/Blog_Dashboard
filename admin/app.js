import * as yaml from './vendor/js-yaml.js';
import * as localStore from './local-store.js';
import * as treeUI from './tree-ui.js';
import * as treeOps from './tree-ops.js';

/* ============================================================
 *  常量 / 工具
 * ============================================================ */
const API = 'https://api.github.com';
const LS_SETTINGS = 'blog-admin:settings:v1';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const pad2 = (n) => String(n).padStart(2, '0');

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), isError ? 4200 : 2400);
}

function setStatus(text) { $('#statusText').textContent = text; }

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** 限制并发的任务池 */
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await worker(item); } catch (e) { console.warn('pool task failed', e); }
    }
  });
  await Promise.all(runners);
}

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

const encPath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

function fmtDateLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtDateIso(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Date -> <input type="datetime-local"> 的值（本地时区） */
function toLocalInputValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 兼容 js-yaml 解析出的 Date / 字符串 */
function parseDateValue(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'string') {
    const d = new Date(v.replace(' ', 'T'));
    if (!isNaN(d)) return d;
  }
  return null;
}

function slugify(title) {
  return String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|#%]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const UNCATEGORIZED = '临时';

/** 分类名 → 合法目录名；空分类落到「临时」 */
function sanitizeFolder(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|#%]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return cleaned || UNCATEGORIZED;
}

/**
 * 推断没有 permalink 字段的文章的实际 URL。
 * Hexo 的 :title 是「相对 _posts 的完整路径」（含分类目录、含文件名里的日期前缀），
 * 这一点实测确认过：技术/a.md → /年/月/日/技术/a/
 */
function guessPermalink(post) {
  const base = String(post.name || '').replace(/\.md$/i, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})-/.exec(base);
  if (!m) return null;
  const folder = post.folder ? `${post.folder}/` : '';
  return `${m[1]}/${m[2]}/${m[3]}/${folder}${base}/`;
}

/** 文章在站点上的完整 URL；无法推断时返回 null */
function postUrl(post) {
  const site = deriveSite();
  const base = `${site.url}${site.root}`.replace(/\/+$/, '');
  const cached = state.titleCache[post.path];

  let permalink = cached && cached.permalink;
  if (!permalink) permalink = guessPermalink(post);
  // 最后兜底：缓存里只有日期时，按 Hexo 的默认规则拼（含目录、含完整文件名）
  if (!permalink && cached && cached.date) {
    const folder = post.folder ? `${post.folder}/` : '';
    permalink = `${String(cached.date).replace(/-/g, '/')}/${folder}${post.name.replace(/\.md$/i, '')}/`;
  }
  if (!permalink) return null;
  return `${base}/${String(permalink).replace(/^\/+/, '')}`;
}

/** 顶栏品牌区的两个链接：博客首页 + GitHub 仓库，直接绑在文字上 */
function updateVisitSite() {
  const siteLink = $('#siteLink');
  const repoLink = $('#repoLink');
  const configured = !!(state.settings.owner && state.settings.repo);

  if (siteLink) {
    if (!configured) {
      siteLink.href = '#';
      siteLink.classList.add('disabled');
      siteLink.removeAttribute('target');
    } else {
      const site = deriveSite();
      siteLink.href = `${site.url}${site.root}`;
      siteLink.classList.remove('disabled');
      siteLink.target = '_blank';
    }
  }

  if (repoLink) {
    if (!configured) {
      repoLink.textContent = '未配置仓库';
      repoLink.href = '#';
      repoLink.classList.add('disabled');
      repoLink.removeAttribute('target');
    } else {
      const full = `${state.settings.owner}/${state.settings.repo}`;
      repoLink.textContent = full;
      repoLink.href = `https://github.com/${full}`;
      repoLink.classList.remove('disabled');
      repoLink.target = '_blank';
    }
  }
}

/* ============================================================
 *  状态
 * ============================================================ */
const state = {
  deletedPaths: new Set(),   // 本地标记删除的路径（同步，渲染时直接查）
  selected: new Set(),   // 多选的文章路径
  settings: {
    owner: '', repo: '', branch: 'main', token: '',
    postsPath: 'source/_posts',
    imagesPath: 'source/images',
    imagePrefix: '/images',
    siteUrl: '',
    framework: 'hexo',
  },
  current: { path: null, sha: null, permalink: null },
  posts: [],
  titleCache: {},
  pendingLocalImages: [],
  expanded: null,
};

function settingsReady() {
  const s = state.settings;
  return !!(s.owner && s.repo && s.token);
}

/* ============================================================
 *  GitHub API
 * ============================================================ */
class ApiError extends Error {
  constructor(message, status = 0, apiMessage = '') {
    super(message);
    this.status = status;
    this.apiMessage = apiMessage;
  }
}

async function gh(path, { method = 'GET', body } = {}) {
  const s = state.settings;
  const url = `${API}/repos/${s.owner}/${s.repo}${path}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      // GitHub 的 API 响应带 max-age=60，浏览器的 HTTP 缓存会返回旧 sha，
      // 拿它去写文件就是 409「文件冲突」。所有请求都别走缓存。
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${s.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError('无法连接 api.github.com（网络被拦截、代理问题或离线）', 0, e.message);
  }

  if (!res.ok) {
    let apiMessage = '';
    try {
      const j = await res.json();
      apiMessage = j.message || '';
    } catch { /* 响应不是 JSON */ }

    let msg;
    if (res.status === 401) msg = 'Token 无效或已过期';
    else if (res.status === 403) {
      msg = /rate limit/i.test(apiMessage)
        ? '触发 API 限流，稍后再试'
        : `权限不足${apiMessage ? '：' + apiMessage : ''}`;
    } else if (res.status === 404) msg = `读不到${apiMessage ? '：' + apiMessage : '资源'}`;
    else if (res.status === 409) {
      // 空仓库读取文件树时 GitHub 返回 409 "Git Repository is empty."
      msg = /empty/i.test(apiMessage)
        ? '仓库还是空的（没有任何提交），先点「初始化 Hexo 站点」'
        : '文件冲突（SHA 已变化），请刷新列表后重试';
    } else if (res.status === 422) msg = `请求被拒绝${apiMessage ? '：' + apiMessage : ''}`;
    else msg = apiMessage || `HTTP ${res.status}`;

    throw new ApiError(msg, res.status, apiMessage);
  }

  if (res.status === 204) return null;
  return res.json();
}

/** 探测仓库本身是否可读（用来区分「连不上」和「目录还没建」） */
async function probeRepo() {
  const repo = await gh('');
  return {
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    isPrivate: !!repo.private,
    size: repo.size,
  };
}

async function getFile(path) {
  const s = state.settings;
  const j = await gh(`/contents/${encPath(path)}?ref=${encodeURIComponent(s.branch)}`);
  if (Array.isArray(j)) throw new Error('目标路径是一个目录');
  let text = '';
  if (j.content) text = b64decodeUtf8(j.content);
  else if (j.download_url) text = await (await fetch(j.download_url)).text();
  return { sha: j.sha, text };
}

async function putFile(path, content, message, sha, watchTitle) {
  const s = state.settings;
  const res = await gh(`/contents/${encPath(path)}`, {
    method: 'PUT',
    body: {
      message,
      content: b64encodeUtf8(content),
      branch: s.branch,
      ...(sha ? { sha } : {}),
    },
  });

  // 单文件提交也会触发 Action，同样盯一下
  const commitSha = res && res.commit && res.commit.sha;
  if (commitSha) startActionWatch(commitSha, watchTitle);

  return res;
}

async function deleteFile(path, sha, message) {
  return gh(`/contents/${encPath(path)}`, {
    method: 'DELETE',
    body: { message, sha, branch: state.settings.branch },
  });
}

async function listDir(path) {
  return gh(`/contents/${encPath(path)}?ref=${encodeURIComponent(state.settings.branch)}`);
}

/* ============================================================
 *  Markdown 渲染（含 KaTeX）
 * ============================================================ */
const md = window.markdownit({
  html: true,
  linkify: true,
  breaks: false,
  highlight(str, lang) {
    const hljs = window.hljs;
    if (hljs && lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch { /* 落到下面的纯文本 */ }
    }
    return `<pre class="hljs"><code>${window.markdownit.utils.escapeHtml(str)}</code></pre>`;
  },
});

// 任务列表：- [ ] / - [x] 渲染成 checkbox（markdown-it 默认不支持）
if (window.markdownitTaskLists) {
  md.use(window.markdownitTaskLists, { enabled: true, label: true });
}

const KATEX_DELIMS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '$', right: '$', display: false },
  { left: '\\(', right: '\\)', display: false },
];

/** 把仓库内图片路径改写为 raw.githubusercontent 地址，便于本地预览 */
function rewriteForPreview(html) {
  // 博客园等图床有防盗链，预览时图片同样要不带 Referer
  const marked = html.replace(/<img /g, '<img referrerpolicy="no-referrer" ');
  const s = state.settings;
  if (!s.owner || !s.repo) return marked;
  const prefix = s.imagePrefix.replace(/\/+$/, '');
  if (!prefix) return marked;
  const rawBase = `https://raw.githubusercontent.com/${s.owner}/${s.repo}/${s.branch}/`
    + s.imagesPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return marked.replace(new RegExp(`src="${esc}`, 'g'), `src="${rawBase}`);
}

/**
 * 去掉 $$ 块内部的空行。
 * markdown-it 会把「$$\n\n公式\n\n$$」拆成三个段落，KaTeX 就找不到配对的 $$。
 * 数学模式里的空行本来也非法，直接压掉是安全的。
 */
function normalizeMathBlocks(text) {
  return String(text || '').replace(/\$\$([\s\S]*?)\$\$/g, (m, inner) => {
    // 逐行处理：去掉「去掉引用前缀后仍为空」的行（引用块里的空行是 ">" 或 "> "），
    // 否则 markdown-it 会把公式拆成多个段落，KaTeX 就配不上对。
    const kept = inner.split('\n').filter((line) => {
      if (line.includes('$$')) return true;
      const stripped = line.replace(/^[ \t]*(?:>[ \t]?)+/, '').trim();
      return stripped !== '';
    });
    // 首尾必须换行：否则会拼出 "$$> \begin" 这种粘连写法，markdown-it 认不出来
    return `$$\n${kept.join('\n').replace(/^\n+|\n+$/g, '')}\n$$`;
  });
}

/** 去掉行内公式两端空白：$ x $ → $x$（markdown-it-katex 遇到两端空白会直接跳过） */
function normalizeInlineMath(text) {
  return String(text || '').replace(/\$(?!\$)([ \t]*)([^$\n]+?)([ \t]*)\$(?!\$)/g, (m, a, inner, b) => {
    if (!inner.trim()) return m;
    return `$${inner.trim()}$`;
  });
}

/** LaTeX 换行的占位符，避免被 markdown-it 当成转义吃掉 */
const MATH_NL = '\u0001MATHNL\u0001';

/**
 * markdown-it 会把 LaTeX 的换行 \\ 转义成 \，导致 aligned 等多行公式塌成一行。
 * 这里先把 $$ 块内的 \\ 换成占位符，渲染完再换回来，交给 KaTeX 处理。
 */
function protectLatexNewlines(text) {
  return String(text || '').replace(/\$\$([\s\S]*?)\$\$/g, (m, inner) =>
    '$' + '$' + inner.replace(/\\\\/g, MATH_NL) + '$' + '$');
}

function restoreLatexNewlines(html) {
  return String(html || '').split(MATH_NL).join('\\\\');
}

/**
 * 把 $ 块抽出来换成占位符，渲染完再替换成 KaTeX HTML。
 * 必须这么做：公式里常有 "    - \sum" 这种行，markdown-it 会当成无序列表，
 * 把整个公式拆碎；换成占位符后 markdown 层完全看不到它。
 */
function extractMathBlocks(text) {
  const blocks = [];
  const out = String(text || '').replace(
    /(^|\n)([ \t]*(?:>[ \t]?)*)[ \t]*\$\$([\s\S]*?)\$\$/g,
    (m, lead, quotePrefix, body) => {
      const latex = body
        .split('\n')
        .map((line) => line.replace(/^[ \t]*>[ \t]?/, ''))
        .join('\n')
        .trim();
      if (!latex) return m;
      const idx = blocks.length;
      blocks.push(latex);
      return lead + quotePrefix + '\u0002MATHBLOCK' + idx + '\u0002';
    },
  );
  return { text: out, blocks };
}

function restoreMathBlocks(html, blocks) {
  if (!blocks.length) return html;
  return String(html).replace(/\u0002MATHBLOCK(\d+)\u0002/g, (m, i) => {
    const latex = blocks[Number(i)];
    if (latex == null) return m;
    if (!window.katex || typeof window.katex.renderToString !== 'function') return m;
    try {
      // 提取时已经把 \\ 换成了占位符，交给我 KaTeX 之前必须换回来
      return window.katex.renderToString(restoreLatexNewlines(latex), { displayMode: true, throwOnError: false });
    } catch {
      return m;
    }
  });
}

/**
 * 任务列表项里的 ATX 标题（- [ ] ##### xxx）改成 HTML 标题。
 * markdown-it 不支持「列表项内的标题」（`#####` 不在行首），但 Typora 支持，
 * 这里用 <h5> 等价实现；标题里的链接/粗体先用 inline 渲染器处理掉，避免失效。
 */
function renderTaskHeadings(engine, text) {
  if (!engine) return text;
  return String(text || '').replace(
    /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\][ \t]+(#{1,6})[ \t]+(.+)$/gm,
    (m, prefix, mark, hashes, content) => {
      const level = hashes.length;
      const checked = mark.toLowerCase() === 'x' ? ' checked' : '';
      let inner = content;
      try {
        inner = engine.renderInline(content);
      } catch { /* 用原文 */ }
      return `${prefix}<input type="checkbox" class="task-list-item-checkbox" disabled${checked}> <h${level}>${inner}</h${level}>`;
    },
  );
}

function previewRender(text, previewEl) {
  const extracted = extractMathBlocks(normalizeMathBlocks(protectLatexNewlines(text)));
  const source = renderTaskHeadings(md, normalizeInlineMath(extracted.text));
  const html = rewriteForPreview(restoreMathBlocks(restoreLatexNewlines(md.render(source)), extracted.blocks));
  setTimeout(() => {
    if (typeof window.renderMathInElement === 'function') {
      try {
        window.renderMathInElement(previewEl, {
          delimiters: KATEX_DELIMS,
          ignoredTags: ['pre', 'code', 'script', 'style', 'textarea'],
          throwOnError: false,
        });
      } catch (e) { console.warn('KaTeX:', e); }
    }
  }, 0);
  return html;
}

/* ============================================================
 *  编辑器
 * ============================================================ */
let editor;

function insertMath(ed) {
  const cm = ed.codemirror;
  const sel = cm.getSelection();
  if (sel) { cm.replaceSelection(`$${sel}$`); return; }
  cm.replaceSelection('$$\n\n$$');
  const c = cm.getCursor();
  cm.setCursor({ line: c.line - 1, ch: 0 });
}

/** 自己实现分屏预览：EasyMDE 内置的 side-by-side 会把编辑器 fixed 全屏，破坏表单布局 */
function toggleSplit() {
  const wrap = $('#editorWrap');
  wrap.classList.toggle('split');
  const btn = document.querySelector('.editor-toolbar button.split');
  if (btn) btn.classList.toggle('active', wrap.classList.contains('split'));
  if (wrap.classList.contains('split')) { renderSidePreview(); setupScrollSync(); }
}

/** 编辑器与预览双向滚动同步：按滚动比例映射，避免来回触发 */
let scrollSyncBound = false;
let scrollSyncing = false;

function setupScrollSync() {
  if (scrollSyncBound || !editor) return;
  const cm = editor.codemirror;
  const wrapEl = cm.getWrapperElement();
  const scroller = wrapEl.querySelector('.CodeMirror-scroll');
  // 真正的滚动容器是 .preview-pane（overflow-y:auto），不是里面的 #sidePreview
  const preview = document.querySelector('.preview-pane');
  if (!scroller || !preview) return;

  const ratioOf = (el) => el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);

  const apply = (from, to) => {
    if (scrollSyncing) return;
    scrollSyncing = true;
    to.scrollTop = ratioOf(from) * Math.max(0, to.scrollHeight - to.clientHeight);
    // 下一个宏任务再解锁，避免 A→B 的赋值又触发 B→A
    setTimeout(() => { scrollSyncing = false; }, 60);
  };

  scroller.addEventListener('scroll', () => apply(scroller, preview), { passive: true });
  preview.addEventListener('scroll', () => apply(preview, scroller), { passive: true });
  scrollSyncBound = true;
}

function renderSidePreview() {
  const wrap = $('#editorWrap');
  if (!wrap || !wrap.classList.contains('split')) return;
  const el = $('#sidePreview');
  // 和正式渲染保持一致的公式规范化：$$ 块内空行、行内 $ 两侧空白
  const extracted = extractMathBlocks(normalizeMathBlocks(protectLatexNewlines(editor.value())));
  const source = renderTaskHeadings(md, normalizeInlineMath(extracted.text));
  el.innerHTML = rewriteForPreview(restoreMathBlocks(restoreLatexNewlines(md.render(source)), extracted.blocks));
  if (typeof window.renderMathInElement === 'function') {
    try {
      window.renderMathInElement(el, {
        delimiters: KATEX_DELIMS,
        ignoredTags: ['pre', 'code', 'script', 'style', 'textarea'],
        throwOnError: false,
      });
    } catch (e) { console.warn('KaTeX:', e); }
  }
  // 本地图片尚不可达时给出可读提示，而不是破图图标
  el.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => {
      const ph = document.createElement('span');
      ph.className = 'img-missing';
      ph.textContent = `[图片未加载：${img.getAttribute('src')}]`;
      img.replaceWith(ph);
    }, { once: true });
  });
}

const scheduleSidePreview = debounce(renderSidePreview, 200);

function buildEditor() {
  editor = new EasyMDE({
    element: $('#editor'),
    autoDownloadFontAwesome: false,
    spellChecker: false,
    status: false,
    minHeight: '260px',
    placeholder: '开始写作……支持 Markdown、LaTeX 公式（$...$ / $$...$$）与图片拖拽上传。',
    renderingConfig: { singleLineBreaks: false },
    toolbar: [
      'bold', 'italic', 'strikethrough', '|',
      'heading-1', 'heading-2', 'heading-3', '|',
      'quote', 'unordered-list', 'ordered-list', '|',
      'link', 'image', 'table', 'code', '|',
      'horizontal-rule',
      { name: 'math', action: insertMath, className: 'fa fa-square-root-variable', title: '插入公式' },
      '|', 'preview',
      { name: 'split', action: toggleSplit, className: 'fa fa-columns', title: '分屏预览' },
      'fullscreen', '|', 'undo', 'redo', 'guide',
    ],
    uploadImage: true,
    imageUploadFunction: (file, onSuccess, onError) => {
      uploadImage(file)
        .then((url) => { onSuccess(url); toast('图片已上传'); })
        .catch((err) => { onError(err.message); toast(`图片上传失败：${err.message}`, true); });
    },
    previewRender,
  });

  editor.codemirror.on('change', () => {
    updateWordCount();
    scheduleAutoSave();
    scheduleSidePreview();
  });
}

function updateWordCount() {
  const text = editor.value();
  const chars = text.replace(/\s/g, '').length;
  $('#wordCount').textContent = `${chars} 字`;
}

/* ============================================================
 *  front-matter
 * ============================================================ */
function splitFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text || '');
  if (!m) return { data: {}, body: text || '' };
  let data = {};
  try { data = yaml.load(m[1]) || {}; } catch (e) { console.warn('front-matter 解析失败', e); }
  return { data, body: text.slice(m[0].length) };
}

function toList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return String(v).split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 把 front-matter 里第一个分类（最外层）替换成新路径，其余分类保留。
 * 只动 categories 那几行，不重新序列化 YAML，避免打乱用户自己的格式和字段顺序。
 * 例：[数论, 筛法] + 目标 ['笔记','数论'] → [笔记, 数论, 筛法]
 */
function insertCategoryPrefix(text, from, toParts) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n?)/.exec(text || '');
  if (!m) return text;

  const fm = m[1];
  const rest = text.slice(m[0].length);
  const { data } = splitFrontMatter(text);
  const cats = toList(data.categories);
  if (!cats.length || cats[0] !== from) return text;

  const newCats = [...toParts, ...cats.slice(1)];
  const block = `categories:\n${newCats.map((c) => `  - ${c}`).join('\n')}`;
  let nextFm;

  if (/^categories:[ \t]*$/m.test(fm)) {
    const replaced = fm.replace(/^categories:[ \t]*\r?\n(?:[ \t]+-.*\r?\n?)*/m, `${block}\n`);
    nextFm = /^categories:/m.test(replaced) ? replaced : `${fm}\n${block}`;
  } else if (/^categories:[ \t]*\[.*\][ \t]*$/m.test(fm)) {
    nextFm = fm.replace(/^categories:.*$/m, `categories: [${newCats.join(', ')}]`);
  } else if (/^categories:[ \t]*\S/m.test(fm)) {
    nextFm = fm.replace(/^categories:.*$/m, block);
  } else {
    nextFm = `${fm}\n${block}`.replace(/\s+$/, '');
  }

  return `---\n${nextFm.replace(/\s+$/, '')}\n---${m[2]}${rest}`;
}

/** 从正文生成纯文本摘要：去掉公式、代码块、图片和 Markdown 记号 */
function makeExcerpt(body, len = 120) {
  const text = String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]+\$/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, ' ')
    .replace(/[>*_`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > len ? `${text.slice(0, len)}…` : text;
}

function buildFrontMatter(doc) {
  const s = state.settings;
  const dt = doc.date instanceof Date && !isNaN(doc.date) ? doc.date : new Date();
  const lines = ['---'];
  lines.push(`title: ${JSON.stringify(doc.title)}`);
  lines.push(`date: ${s.framework === 'hugo' ? fmtDateIso(dt) : fmtDateLocal(dt)}`);
  if (doc.order != null && doc.order !== '') lines.push(`order: ${Number(doc.order)}`);
  if (doc.permalink) lines.push(`permalink: ${JSON.stringify(doc.permalink)}`);
  if (doc.excerpt) lines.push(`excerpt: ${JSON.stringify(doc.excerpt)}`);
  // 加密文章的摘要不加密，显示在密码框上方
  if (doc.abstract) lines.push(`abstract: ${JSON.stringify(doc.abstract)}`);
  const catList = toList(doc.categories);
  if (catList.length) {
    lines.push('categories:');
    catList.forEach((x) => lines.push(`  - ${JSON.stringify(x)}`));
  }
  const tagList = toList(doc.tags);
  if (tagList.length) {
    lines.push('tags:');
    tagList.forEach((t) => lines.push(`  - ${JSON.stringify(t)}`));
  }
  // 加密文章：hexo-blog-encrypt 会读这个字段，构建时把正文加密成密文
  if (doc.password) lines.push(`password: ${JSON.stringify(doc.password)}`);
  if (doc.draft) lines.push('draft: true');
  // LaTeX 里的颜色写法（如 \color {#C0C0C0}）会被 Hexo 当成 Swig 注释开头，
  // 导致 "expected end of comment" 构建失败，这里关掉该文的 Nunjucks 解析
  if (doc.disableNunjucks) lines.push('disableNunjucks: true');
  lines.push('---', '');
  return lines.join('\n');
}

/* ============================================================
 *  表单 <-> 文档
 * ============================================================ */
function collectForm() {
  const raw = $('#fDate').value;
  return {
    title: $('#fTitle').value.trim(),
    date: raw ? new Date(raw) : new Date(),
    categories: toList($('#fCategories').value),
    tags: toList($('#fTags').value),
    slug: $('#fSlug').value.trim(),
    draft: false,
    excerpt: $('#fExcerpt').value.trim(),
    password: $('#fPassword').value.trim(),
    body: editor.value(),
  };
}

function fillForm(doc) {
  $('#fTitle').value = doc.title || '';
  $('#fDate').value = toLocalInputValue(doc.date instanceof Date && !isNaN(doc.date) ? doc.date : new Date());
  $('#fCategories').value = (doc.categories || []).join(', ');
  $('#fTags').value = (doc.tags || []).join(', ');
  $('#fSlug').value = doc.slug || '';
  $('#fExcerpt').value = doc.excerpt || '';
  $('#fPassword').value = doc.password || '';
}

function newDocument(openEditor = true) {
  state.current = { path: null, sha: null, permalink: null };
  fillForm({ date: new Date() });
  markEditorClean();
  markAutoSaveBaseline();
  editor.value('');
  $('#fSlug').value = '';
  $('#postList .active')?.classList.remove('active');
  setStatus('新建文章');
  if (openEditor) $('#fTitle').focus();

}

/* ============================================================
 *  自动保存
 * ============================================================ */
/** 上次自动保存时的整篇文档指纹（正文 + 表单字段），用来判断是否真有改动 */
let lastAutoSaveHash = null;

function docFingerprint() {
  const doc = collectForm();
  doc.body = editor.value();
  const when = doc.date instanceof Date ? doc.date.getTime() : 0;
  return localStore.hashContent(JSON.stringify({
    title: doc.title,
    when,
    categories: doc.categories,
    tags: doc.tags,
    password: doc.password,
    excerpt: doc.excerpt,
    slug: doc.slug,
    body: doc.body,
  }));
}

/** 标记当前状态为「已保存」，避免程序化填充内容后被当成用户改动 */
function markAutoSaveBaseline() {
  try { lastAutoSaveHash = docFingerprint(); } catch { lastAutoSaveHash = null; }
}

/**
 * 自动本地保存：正文和表单字段（标题/分类/密码/摘要…）任意一项变了就写。
 * 用整篇指纹对比，不再只看 CodeMirror 的 isClean()。
 */
const scheduleAutoSave = debounce(async () => {
  try {
    const fp = docFingerprint();
    if (fp === lastAutoSaveHash) return;      // 真没改动

    const ok = await saveLocal({ silent: true, refresh: false });
    if (ok) {
      lastAutoSaveHash = docFingerprint();
      setStatus('已自动保存到本地 · ' + new Date().toLocaleTimeString());
    }
  } catch (e) {
    console.warn('自动保存失败', e);
  }
}, 1500);

/** 把当前编辑内容标记为「干净」，之后的变更才算用户修改 */
function markEditorClean() {
  try { editor.codemirror.markClean(); } catch { /* 忽略 */ }
}

/* ============================================================
 *  文章列表
 * ============================================================ */
/** 只存在于本地的空分类（相对 postsPath，去掉前缀） */
let localEmptyDirs = treeUI.loadLocalDirs();

const LS_EXPANDED = 'blog-admin:expanded:v1';

function loadExpanded() {
  try {
    const raw = localStorage.getItem(LS_EXPANDED);
    if (raw) state.expanded = new Set(JSON.parse(raw));
  } catch { state.expanded = null; }
}

function saveExpanded() {
  if (!state.expanded) return;
  try { localStorage.setItem(LS_EXPANDED, JSON.stringify([...state.expanded])); } catch { /* 忽略配额 */ }
}

/** 标题 / 文件名 / 分类 / 标签 都能命中 */
function matchesQuery(p, q) {
  const c = state.titleCache[p.path];
  const hay = [
    p.name,
    (c && c.title) || '',
    p.folder || '',
    ...((c && c.tags) || []),
    ...((c && c.categories) || []),
  ].join(' ').toLowerCase();
  return hay.includes(q);
}

function buildTree(posts) {
  const root = { dirs: new Map(), files: [] };
  for (const p of posts) {
    const segs = (p.folder || '').split('/').filter(Boolean);
    let node = root;
    for (const seg of segs) {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    }
    node.files.push(p);
  }
  return root;
}

function collectDirKeys(node, prefix = '', out = []) {
  for (const [name, child] of node.dirs) {
    const key = prefix ? `${prefix}/${name}` : name;
    out.push(key);
    collectDirKeys(child, key, out);
  }
  return out;
}

/** 某目录子树里有多少个本地差异文件（红点/角标用） */
function countDirDiff(node) {
  if (!(state.diff instanceof Map) || !node) return 0;
  let n = 0;
  for (const f of node.files) {
    const d = state.diff.get(f.path);
    if (d && d.status !== 'same') n++;
  }
  for (const child of node.dirs.values()) n += countDirDiff(child);
  return n;
}

function countFiles(node) {
  let n = node.files.length;
  for (const child of node.dirs.values()) n += countFiles(child);
  return n;
}

function renderFileItem(p) {
  const li = document.createElement('li');
  li.className = 'tree-file';
  li.dataset.path = p.path;
  if (p.path === state.current.path) li.classList.add('active');
  if (state.selected && state.selected.has(p.path)) li.classList.add('selected');

  // 本地差异标记（内容真变了才标，不是保存过就标）
  const diff = state.diff instanceof Map ? state.diff.get(p.path) : null;
  if (diff && diff.status !== 'same') {
    li.classList.add(`diff-${diff.status}`);
  }
  // 标记删除：用同步集合，避免被异步重建的 state.diff 覆盖
  if (state.deletedPaths && state.deletedPaths.has(p.path)) {
    li.classList.add('diff-deleted');
  } else if (p.isDeletedPlaceholder) {
    li.classList.add('diff-deleted');
  }

  const row = document.createElement('div');
  row.className = 'tree-row';

  const cached = state.titleCache[p.path];
  const title = document.createElement('span');
  title.className = 'file-title';
  title.textContent = (cached && cached.title) || p.name.replace(/\.md$/i, '');
  title.title = p.path;

  const actions = document.createElement('span');
  actions.className = 'post-actions';

  const url = postUrl(p);
  if (url) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'post-open';
    open.title = '在浏览器打开文章页面';
    open.textContent = '↗';
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(url, '_blank', 'noopener');
    });
    actions.appendChild(open);
  }

  const del = document.createElement('button');
  del.className = 'post-del';
  del.type = 'button';
  del.title = '删除这篇文章';
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deletePostItem(p);
  });
  actions.appendChild(del);

  row.append(title, actions);
  row.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      toggleSelect(p.path);
      return;
    }
    if (state.selected && state.selected.size) state.selected.clear();
    openPost(p).catch((err) => toast(err.message, true));
  });
  row.addEventListener('contextmenu', (e) => openFileMenu(e, p));
  if (!p.isDeletedPlaceholder) {
    bindDragAndDrop(row, p);
    bindFileDrop(row, p);
  }
  li.appendChild(row);
  return li;
}

function renderTreeNode(node, container, prefix, forceOpen) {
  // 目录在前，按名称排序
  const dirs = [...node.dirs].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
  for (const [name, child] of dirs) {
    const key = prefix ? `${prefix}/${name}` : name;
    const li = document.createElement('li');
    li.className = 'tree-dir';
    li.dataset.dir = key;

    const fileCountInDir = countFiles(child);
    if (!fileCountInDir) li.classList.add('is-empty');

    const open = forceOpen || (state.expanded && state.expanded.has(key));
    if (!open) li.classList.add('collapsed');

    const row = document.createElement('div');
    row.className = 'tree-row';

    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    caret.textContent = '▼';

    const dirName = document.createElement('span');
    dirName.className = 'dir-name';
    dirName.textContent = name;

    // 该目录下有多少本地差异文件：紧贴分类名右侧，不把标题顶走
    const diffCount = countDirDiff(child);
    let badge = null;
    if (diffCount) {
      badge = document.createElement('span');
      badge.className = 'dir-diff-badge';
      badge.textContent = String(diffCount);
      badge.title = `${diffCount} 个本地改动`;
    }

    const count = document.createElement('span');
    count.className = 'dir-count';
    count.textContent = String(countFiles(child));

    row.append(caret, dirName);
    if (badge) row.appendChild(badge);
    row.appendChild(count);
    row.addEventListener('contextmenu', (e) => openDirMenu(e, key));
    bindDirDrop(row, key);

    row.addEventListener('click', () => {
      if (forceOpen) return; // 搜索时保持展开
      if (!state.expanded) state.expanded = new Set();
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      saveExpanded();
      li.classList.toggle('collapsed');
    });

    const ul = document.createElement('ul');
    ul.className = 'tree-children';
    renderTreeNode(child, ul, key, forceOpen);

    li.append(row, ul);
    container.appendChild(li);
  }

  // 不再在这里排序：顺序由 state.posts 决定，拖拽调序才能生效。
  // 初始顺序由 loadPosts 的排序给出，调过序后由 applyLocalOrder 维持。
  for (const p of node.files) container.appendChild(renderFileItem(p));
}


/* ============================================================
 *  文件树交互：右键菜单 / 重命名 / 新建 / 拖拽移动
 * ============================================================ */

/** 取某个文章项的当前内容（本地优先，其次列表里缓存的） */
async function contentOfPost(item) {
  const local = await localStore.getLocal(item.path);
  if (local && !local.deleted) return local.content;
  if (item.localContent) return item.localContent;
  try {
    return (await getFile(item.path)).text;
  } catch {
    return null;
  }
}

/**
 * 把一个元素临时换成输入框，回车提交、Esc/失焦取消。
 * onCommit(value) 只在回车时调用，value 已 trim。
 */
function startInlineEdit(el, { initial = "", placeholder = "", onCommit }) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-edit";
  input.value = initial;
  input.placeholder = placeholder;

  const parent = el.parentNode;
  const next = el.nextSibling;
  parent.replaceChild(input, el);
  input.focus();
  if (initial) input.select();

  let settled = false;
  const restore = () => {
    if (settled) return;
    settled = true;
    if (input.parentNode) input.parentNode.replaceChild(el, input);
  };
  const commit = () => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    if (input.parentNode) input.parentNode.replaceChild(el, input);
    if (value) onCommit(value);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); settled = true; if (input.parentNode) input.parentNode.replaceChild(el, input); }
  });
  input.addEventListener("blur", () => {
    // 回车已经处理过时 settled 为 true，这里不重复
    if (!settled) { settled = true; if (input.parentNode) input.parentNode.replaceChild(el, input); }
  });
}

/** 新建一个只在本地存在的分类 */
function newCategoryUnder(parentDir) {
  // 在树上插入一个临时行，直接原地输入（不再弹 prompt）
  const list = $('#postList');
  if (!list) return;

  const li = document.createElement('li');
  li.className = 'tree-dir inline-new';
  const row = document.createElement('div');
  row.className = 'tree-row';
  const caret = document.createElement('span');
  caret.className = 'tree-caret';
  caret.textContent = '▼';
  const label = document.createElement('span');
  label.className = 'dir-name';
  label.textContent = '';
  row.append(caret, label);
  li.appendChild(row);
  list.insertBefore(li, list.firstChild);

  if (state.expanded) state.expanded.add(parentDir);

  startInlineEdit(label, {
    placeholder: '新分类名称（回车确认，可带 /）',
    onCommit: (name) => {
      if (!name) { li.remove(); return; }
      const rel = parentDir ? parentDir + '/' + name : name;
      localEmptyDirs.add(rel);
      treeUI.saveLocalDirs(localEmptyDirs);
      li.remove();
      renderList();
      setStatus('已新建分类「' + rel + '」（仅本地）');
    },
  });
  // 取消时移除临时行
  setTimeout(() => {
    const inp = li.querySelector('.inline-edit');
    if (inp) inp.addEventListener('blur', () => { if (!li.dataset.done) setTimeout(() => li.remove(), 0); });
  }, 0);
}

/** 在指定分类下新建文章 */
function newPostUnder(dirRel) {
  const title = '未命名';
  const date = new Date();
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const da = String(date.getDate()).padStart(2, '0');
  const postsPath = (state.settings.postsPath || 'source/_posts').replace(/\/+$/, '');
  const folder = dirRel ? dirRel.replace(/\//g, '/') : UNCATEGORIZED;
  let base = 'untitled';
  let path = postsPath + '/' + folder + '/' + y + '-' + mo + '-' + da + '-' + base + '.md';
  let n = 1;
  const occupied = new Set(state.posts.map((p) => p.path));
  while (occupied.has(path)) { base = 'untitled-' + (++n); path = postsPath + '/' + folder + '/' + y + '-' + mo + '-' + da + '-' + base + '.md'; }

  const content = '---\ntitle: 未命名\ndate: ' + date.toISOString().slice(0, 10) + ' ' + date.toTimeString().slice(0, 8) + '\ncategories:\n' + folder.split('/').map((x) => '  - ' + x).join('\n') + '\n---\n\n';
  localStore.putLocal(path, content).then(() => {
    state.titleCache[path] = {
      title: '未命名',
      sha: null,
      tags: [],
      categories: folder.split('/').filter(Boolean),
    };
    saveTitleCache();
    state.posts.push({ name: path.split('/').pop(), path, sha: null, folder });
    renderList();
    const item = state.posts.find((p) => p.path === path);
    if (item) openPost(item).catch((e) => toast(e.message, true));
    setStatus('已新建文章（仅本地）');
  }).catch((e) => toast('新建失败：' + e.message, true));
}

/** 重命名文章 */
async function renamePostItem(item) {
  // 这里给用户改的是「标题」，不是文件名；文件名由标题自动推出来。
  const cached = state.titleCache[item.path];
  const currentTitle = (cached && cached.title) || item.name.replace(/\.md$/i, '');

  const li = document.querySelector(`#postList .tree-file[data-path="${CSS.escape(item.path)}"]`);
  const titleEl = li && li.querySelector('.file-title');
  if (!titleEl) { toast('找不到这个文件，刷新一下再试', true); return; }

  startInlineEdit(titleEl, {
    initial: currentTitle,
    placeholder: '文章标题',
    onCommit: (input) => { applyPostRename(item, currentTitle, input); },
  });
}

async function applyPostRename(item, oldName, input) {
  const title = String(input || '').trim();
  if (!title || title === oldName) return;

  // 输入的是「标题」，文件名跟着标题走：保留原来的日期前缀，扩展名固定 .md
  const content = await contentOfPost(item);
  if (content == null) { toast('读不到这篇文章的内容', true); return; }

  const datePrefix = (/^(\d{4}-\d{2}-\d{2})/.exec(item.name) || [])[1] || '';
  const slug = slugify(title) || 'untitled';
  const fileName = datePrefix ? `${datePrefix}-${slug}.md` : `${slug}.md`;
  let newPath = treeOps.renameFile(item.path, fileName);

  // 先把新内容准备好（标题已改），再整体搬到新路径
  const { data, body } = splitFrontMatter(content);
  const when = data.date instanceof Date ? data.date : new Date(data.date || Date.now());
  const next = buildFrontMatter({
    ...data,
    date: when,
    title,
    categories: toList(data.categories),
    tags: toList(data.tags),
  }) + body;

  const oldPath = item.path;
  const actualPath = await treeUI.relocateFile(oldPath, newPath, next, { sourceInRepo: !!item.sha });
  newPath = actualPath;

  state.titleCache[newPath] = { ...(state.titleCache[oldPath] || {}), title, sha: null };
  delete state.titleCache[oldPath];
  saveTitleCache();

  // 改名 = 删除 + 创建：原文件名在列表里显示为已删除
  const renameWasInRepo = !!item.sha;
  recordMovedPlaceholder(oldPath, item.sha, (state.settings.postsPath || 'source/_posts').replace(/\/+$/, ''), content);

  item.path = newPath;
  item.name = newPath.split('/').pop();
  item.sha = null;
  item.localContent = next;
  if (state.current && state.current.path === oldPath) {
    state.current = { ...state.current, path: newPath, sha: null };
  }
  renderList();
  await refreshDiffFromState();
  setStatus('已改名为「' + title + '」');
}

/** 重命名分类（含其下所有文章） */
async function renameCategory(dirRel) {
  const oldName = dirRel.split('/').pop();

  const li = document.querySelector(`#postList .tree-dir[data-dir="${CSS.escape(dirRel)}"]`);
  const nameEl = li && li.querySelector('.dir-name');
  if (!nameEl) { toast('找不到这个分类，刷新一下再试', true); return; }

  startInlineEdit(nameEl, {
    initial: oldName,
    placeholder: '分类名',
    onCommit: (input) => { applyCategoryRename(dirRel, oldName, input); },
  });
}

async function applyCategoryRename(dirRel, oldName, input) {
  if (!input || input === oldName) return;

  const parent = dirRel.split('/').slice(0, -1).join('/');
  const newRel = parent ? parent + '/' + input : input;
  const postsPath = (state.settings.postsPath || 'source/_posts').replace(/\/+$/, '');
  const oldAbs = postsPath + '/' + dirRel;
  const newAbs = postsPath + '/' + newRel;

  const affected = state.posts.filter((p) => p.path.startsWith(oldAbs + '/'));
  const contents = new Map();
  for (const p of affected) {
    const raw = await contentOfPost(p);
    if (raw == null) { contents.set(p.path, null); continue; }
    // 目录换名后，这批文章的分类要跟着改
    const oldDirRel = treeOps.dirname(p.path).slice(postsPath.length + 1);
    const newDirRel = oldDirRel === dirRel
      ? newRel
      : oldDirRel.startsWith(dirRel + '/')
        ? newRel + oldDirRel.slice(dirRel.length)
        : oldDirRel;
    contents.set(p.path, withNewCategories(raw, newDirRel));
  }

  const moved = await treeUI.relocateDir(oldAbs, newAbs, affected.map((p) => p.path), (p) => contents.get(p));

  for (const p of affected) {
    const to = moved.find((m) => m.from === p.path);
    if (!to) continue;
    p.path = to.to;
    p.name = to.to.split('/').pop();
    p.folder = treeOps.dirname(to.to).slice(postsPath.length + 1);
  }

  // 空分类集合里也换名
  const nextDirs = new Set();
  for (const d of localEmptyDirs) {
    nextDirs.add(d === dirRel ? newRel : d.startsWith(dirRel + '/') ? newRel + d.slice(dirRel.length) : d);
  }
  localEmptyDirs = nextDirs;
  treeUI.saveLocalDirs(localEmptyDirs);

  renderList();
  await refreshDiffFromState();
  setStatus('分类已重命名为 ' + input);
}

/** 删除文章（只删本地，上传时同步删除） */
async function deletePostItem(item) {
  // 不弹确认：只在本地标记删除，列表里保留并显示删除线，点进去可以恢复
  const existing = await localStore.getLocal(item.path);
  if (!existing || !existing.content) {
    // 还没缓存过内容，先拉一份下来，否则「点开恢复」会得到空文章
    const text = await contentOfPost(item);
    if (text != null) {
      await localStore.putLocal(item.path, text, { markSynced: true, baseSha: item.sha });
    }
  }
  await localStore.markDeleted(item.path);
  if (!state.deletedPaths) state.deletedPaths = new Set();
  state.deletedPaths.add(item.path);
  if (!state.diff) state.diff = new Map();
  state.diff.set(item.path, { status: 'deleted' });
  renderList();
  setStatus('已标记删除（仅本地，点开该文章可恢复）');
}

/** 删除分类（连带其中的文章） */
async function deleteCategory(dirRel) {
  const postsPath = (state.settings.postsPath || 'source/_posts').replace(/\/+$/, '');
  const oldAbs = postsPath + '/' + dirRel;
  const affected = state.posts.filter((p) => p.path.startsWith(oldAbs + '/'));
  // 不弹确认：只标记删除，上传后才真正移除

  for (const p of affected) await localStore.markDeleted(p.path);

  localEmptyDirs = new Set([...localEmptyDirs].filter((d) => d !== dirRel && !d.startsWith(dirRel + '/')));
  treeUI.saveLocalDirs(localEmptyDirs);

  renderList();
  setStatus('已删除分类（仅本地）');
}

/** 把文章移动到指定分类 */
/**
 * 按「新的分类目录」改写 front-matter 的 categories。
 * 不这么做的话，文件挪了但分类没变，点「整理」又会按旧分类挪回去。
 */
function withNewCategories(content, dirRel) {
  const { data, body } = splitFrontMatter(content);
  const cats = dirRel ? String(dirRel).split('/').filter(Boolean) : [];
  const when = data.date instanceof Date ? data.date : new Date(data.date || Date.now());
  return buildFrontMatter({
    ...data,
    date: when,
    categories: cats,
    tags: toList(data.tags),
  }) + body;
}

/**
 * 移动/改名后，在列表里留一条「原路径已删除」的占位。
 * 只在源文件确实存在于仓库时才留——纯本地新建的文件移走不该留下删除线。
 * originalContent 用于拖回原位时判断内容是否真的一致。
 */
function recordMovedPlaceholder(oldPath, oldSha, postsPath, originalContent) {
  if (!oldSha) return;
  if (state.posts.some((p) => p.path === oldPath && p.isDeletedPlaceholder)) return;
  state.posts.push({
    name: oldPath.split('/').pop(),
    path: oldPath,
    sha: oldSha,
    folder: treeOps.dirname(oldPath).slice(postsPath.length + 1),
    isDeletedPlaceholder: true,
    originalContent,
  });
}

async function movePostTo(item, targetDirRel, opts = {}) {
  const postsPath = (state.settings.postsPath || 'source/_posts').replace(/\/+$/, '');
  const targetAbs = targetDirRel === null
    ? postsPath                                  // 根目录（不带任何分类）
    : postsPath + '/' + (targetDirRel || UNCATEGORIZED);
  let newPath = treeOps.moveInto(item.path, targetAbs);
  if (newPath === item.path) return;

  const content = await contentOfPost(item);
  if (content == null) {
    toast(`《${item.name}》读不到内容，可能没联网或仓库权限不足`, true);
    setStatus('移动失败：读不到文章内容');
    return;
  }

  const oldPath = item.path;
  const nextContent = withNewCategories(content, targetDirRel === null ? '' : targetDirRel);

  // 目标位置原本是「已删除」时，先记下它的同步基准，用来判断拖回后算 same 还是 modified
  const targetBefore = await localStore.getLocal(newPath);
  const actualPath = await treeUI.relocateFile(oldPath, newPath, nextContent, {
    sourceInRepo: !!item.sha,   // 源文件在仓库里 → 原位置显示「已删除」；纯本地文件直接抹掉
  });
  newPath = actualPath;


  // 标题缓存跟着新路径走，否则列表会退化成显示文件名
  if (state.titleCache && state.titleCache[oldPath]) {
    state.titleCache[newPath] = state.titleCache[oldPath];
    delete state.titleCache[oldPath];
    saveTitleCache();
  } else {
    // 缓存里没有就从内容里解析一次
    try {
      const parsed = splitFrontMatter(content);
      if (parsed.data && parsed.data.title) {
        state.titleCache[newPath] = { ...(state.titleCache[newPath] || {}), title: String(parsed.data.title) };
        saveTitleCache();
      }
    } catch { /* 忽略 */ }
  }

  // 原路径留一个「已删除」占位项：列表里要能看到「它从哪儿被移走了」
  const wasInRepo = !!item.sha;
  recordMovedPlaceholder(oldPath, item.sha, postsPath, content);

  item.path = newPath;
  item.name = newPath.split('/').pop();
  item.folder = treeOps.dirname(newPath).slice(postsPath.length + 1);
  item.sha = null;          // 新路径在仓库里还没有，别再拿旧 sha 去读
  item.localContent = nextContent;
  item.isDeletedPlaceholder = false;

  // 目标位置如果原本是一条「已删除」占位（拖回去了），就把它恢复成正常项，
  // 并把刚移动过来的那条从列表里去掉，避免同一路径出现两次。
  if (state.deletedPaths) state.deletedPaths.delete(newPath);
  const placeholder = state.posts.find((p) => p.path === newPath && p.isDeletedPlaceholder && p !== item);
  if (placeholder) {
    placeholder.isDeletedPlaceholder = false;
    placeholder.sha = null;
    state.posts = state.posts.filter((p) => p !== item);
  }

  // 正在编辑的就是这篇时，把当前路径也切过去，否则保存会写回旧路径
  if (state.current && state.current.path === oldPath) {
    state.current = { ...state.current, path: newPath, sha: null };
  }
  await refreshDiffFromState();
  // 目标原本是删除占位 → 拖回原位。用占位项存下的原始内容做精确比对：
  //   内容一致 → 无修改；不一致 → 修改
  if (targetBefore && targetBefore.deleted) {
    const snapshot = state.posts.find((p) => p.path === newPath && p.isDeletedPlaceholder)?.originalContent;
    let same = true;
    if (snapshot != null) {
      same = localStore.hashContent(snapshot) === localStore.hashContent(nextContent);
    }
    if (!state.diff) state.diff = new Map();
    state.diff.set(newPath, { status: same ? 'same' : 'modified' });
  }
  if (state.deletedPaths) state.deletedPaths.delete(newPath);
  renderList();
  if (!opts.silent) setStatus('已移动到 ' + (targetDirRel === null ? '根目录' : (targetDirRel || UNCATEGORIZED)));
}

/** 弹出菜单：文件 */

/* ---------------- 多选 ---------------- */

function toggleSelect(path) {
  if (!state.selected) state.selected = new Set();
  if (state.selected.has(path)) state.selected.delete(path);
  else state.selected.add(path);
  renderList();
}

function clearSelection() {
  if (!state.selected || !state.selected.size) return false;
  state.selected.clear();
  renderList();
  return true;
}

/** 右键时真正要操作的对象：右键已选中的就用全部选中的，否则只用这一个 */
function targetsFor(item) {
  if (state.selected && state.selected.has(item.path) && state.selected.size > 1) {
    return state.posts.filter((p) => state.selected.has(p.path));
  }
  return [item];
}

async function deleteSelected(items) {
  if (!items.length) return;
  if (!state.deletedPaths) state.deletedPaths = new Set();
  if (!state.diff) state.diff = new Map();
  for (const item of items) {
    await localStore.markDeleted(item.path);
    state.deletedPaths.add(item.path);
    state.diff.set(item.path, { status: 'deleted' });
  }
  if (state.selected) state.selected.clear();
  renderList();
  setStatus('已标记删除 ' + items.length + ' 篇（仅本地，点开可恢复）');
}

async function moveSelected(items, targetDirRel) {
  if (!items.length) return;
  for (const item of items) await movePostTo(item, targetDirRel, { silent: true });
  if (state.selected) state.selected.clear();
  renderList();
  setStatus('已移动 ' + items.length + ' 篇到 ' + (targetDirRel === null ? '根目录' : (targetDirRel || UNCATEGORIZED)));
}

function openFileMenu(e, item) {
  e.preventDefault();
  e.stopPropagation();

  const targets = targetsFor(item);
  const multi = targets.length > 1;

  treeUI.showCtxMenu(e.clientX, e.clientY, [
    { title: multi ? `已选 ${targets.length} 篇` : item.name },
    { label: '重命名…', run: () => renamePostItem(item) },
    { label: multi ? `移动这 ${targets.length} 篇到分类…` : '移动到分类…', run: () => {
        const to = window.prompt('移动到哪个分类？（用 / 表示层级，留空表示临时，输入 / 表示根目录）', item.folder || '');
        if (to == null) return;
        const trimmed = to.trim();
        if (trimmed === '/') moveSelected(targets, null);
        else if (multi) moveSelected(targets, trimmed);
        else movePostTo(item, trimmed);
      } },
    { sep: true },
    { label: multi ? `删除这 ${targets.length} 篇` : '删除', danger: true, run: () => {
        if (multi) deleteSelected(targets);
        else deletePostItem(item);
      } },
  ]);
}

/** 弹出菜单：分类 */
function openDirMenu(e, dirRel) {
  e.preventDefault();
  e.stopPropagation();
  treeUI.showCtxMenu(e.clientX, e.clientY, [
    { title: dirRel },
    { label: '新建文章', run: () => newPostUnder(dirRel) },
    { label: '新建子分类…', run: () => newCategoryUnder(dirRel) },
    { sep: true },
    { label: '重命名…', run: () => renameCategory(dirRel) },
    { label: '删除分类', danger: true, run: () => deleteCategory(dirRel) },
  ]);
}

/** 弹出菜单：空白处 */
function openBlankMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  treeUI.showCtxMenu(e.clientX, e.clientY, [
    { label: '新建文章', run: () => newPostUnder('') },
    { label: '新建分类…', run: () => newCategoryUnder('') },
  ]);
}

/** 绑定拖拽：文件行可拖，目录行可放 */
/** 正在拖的文件路径（用全局标记判断，别依赖 dataTransfer.types：
 *  部分浏览器在 dragover 阶段 types 里拿不到 text/plain，导致 preventDefault 不执行，drop 永远不触发） */
let draggingPaths = [];

function bindDragAndDrop(row, item) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    // 拖的是已选中的项，就整批移动
    const paths = (state.selected && state.selected.has(item.path) && state.selected.size > 1)
      ? [...state.selected]
      : [item.path];
    draggingPaths = paths;
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    draggingPaths = [];
  });
}


/**
 * 拖到另一篇文章上 = 插到它前面，并给同目录所有文章重写 order。
 * 前台分类页按 order 排序，所以调完序刷新站点顺序就跟着变。
 */
async function reorderBeside(srcItem, targetItem) {
  const postsPath = (state.settings.postsPath || 'source/_posts').replace(/\/+$/, '');
  const folder = treeOps.dirname(targetItem.path);
  if (treeOps.dirname(srcItem.path) !== folder) {
    // 跨目录拖拽当成「移动」处理
    const rel = folder.slice(postsPath.length + 1);
    await movePostTo(srcItem, rel);
    return;
  }

  // 保持当前显示顺序，不要按 path 重排——否则第二次拖拽时，
  // 计算用的顺序和用户看到的顺序不一致，就会「有些有效有些乱」。
  const siblings = state.posts.filter((p) => treeOps.dirname(p.path) === folder);

  const from = siblings.findIndex((p) => p.path === srcItem.path);
  const to = siblings.findIndex((p) => p.path === targetItem.path);
  if (from < 0 || to < 0 || from === to) return;

  // 先摘出来，再按方向插入：
  //   从上往下拖（from < to）→ 放到目标之后
  //   从下往上拖（from > to）→ 放到目标之前
  const downward = from < to;
  const [moved] = siblings.splice(from, 1);
  const idx = siblings.findIndex((p) => p.path === targetItem.path);
  if (idx < 0) {
    siblings.push(moved);
  } else {
    siblings.splice(downward ? idx + 1 : idx, 0, moved);
  }

  // 1) 先把顺序应用上去，让本地列表立刻变化——不要等写 front-matter，
  //    那一步要读内容，遇到网络/权限问题会把整个调序卡住。
  const others = state.posts.filter((p) => treeOps.dirname(p.path) !== folder);
  state.posts = [...others, ...siblings];
  renderList();

  // 2) 再异步把 order 写进 front-matter（前台分类页按它排）
  for (let i = 0; i < siblings.length; i++) {
    const item = siblings[i];
    try {
      const content = await contentOfPost(item);
      if (content == null) continue;
      const { data, body } = splitFrontMatter(content);
      const when = data.date instanceof Date ? data.date : new Date(data.date || Date.now());
      const next = buildFrontMatter({
        ...data,
        date: when,
        categories: toList(data.categories),
        tags: toList(data.tags),
        order: i + 1,
      }) + body;
      await localStore.putLocal(item.path, next);
      item.localContent = next;
    } catch (e) { console.warn('写入 order 失败', item.path, e); }
  }

  renderList();
  setStatus('顺序已调整（写入 order，尚未上传）');
}

/** 绑到文件行：拖到另一篇文章上即调序 */
function bindFileDrop(row, item) {
  row.addEventListener('dragover', (e) => {
    if (!draggingPaths.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drop-target');
    const raw = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
    const srcPath = raw || (draggingPaths[0] || '');
      if (!srcPath || srcPath === item.path) return;
    const src = state.posts.find((p) => p.path === srcPath);
    if (src) await reorderBeside(src, item);
  });
}

function bindDirDrop(row, dirRel) {

  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('drop-target');
    const raw = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
    const paths = (raw ? raw.split('\n') : draggingPaths).filter(Boolean);
    if (!paths.length) return;
    const targets = state.posts.filter((p) => paths.includes(p.path));
    if (targets.length > 1) await moveSelected(targets, dirRel);
    else if (targets.length === 1) await movePostTo(targets[0], dirRel);
  });
}

/** 按相对路径在树里确保目录节点存在（用于本地新建的空分类） */
function ensureDirNode(root, rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  let node = root;
  for (const p of parts) {
    if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
    node = node.dirs.get(p);
  }
  return node;
}

function renderList() {

  const q = $('#search').value.trim().toLowerCase();
  const list = $('#postList');
  list.innerHTML = '';

  const filtered = q ? state.posts.filter((p) => matchesQuery(p, q)) : state.posts;

  $('#postCount').textContent = q
    ? `${filtered.length}/${state.posts.length} 篇`
    : `${state.posts.length} 篇`;

  if (!filtered.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.posts.length ? '没有匹配的文章' : '暂无文章';
    list.appendChild(li);
    return;
  }

  const tree = buildTree(filtered);

  // 只在本地存在的空分类也要显示出来
  for (const d of localEmptyDirs) ensureDirNode(tree, d);

  // 首次加载时展开所有目录
  if (!state.expanded) {
    state.expanded = new Set(collectDirKeys(tree));
    saveExpanded();
  }

  renderTreeNode(tree, list, '', !!q);
}

async function loadPosts() {
  if (!settingsReady()) return;
  setStatus('连接仓库…');
  setConn(null);

  let repo;
  try {
    repo = await probeRepo();
  } catch (e) {
    setConn(false);
    toast(`连接失败：${e.message}`, true);
    setStatus(`连接失败：${e.message}`);
    return;
  }

  setConn(true);
  state.repoInfo = repo;

  const branchWarn = repo.defaultBranch && repo.defaultBranch !== state.settings.branch
    ? `（仓库默认分支是 ${repo.defaultBranch}，当前设置是 ${state.settings.branch}）`
    : '';

  // 用 Trees API 递归取文件，支持「分类子目录」结构
  const prefix = `${state.settings.postsPath.replace(/\/+$/, '')}/`;

  try {
    const tree = await gh(`/git/trees/${encodeURIComponent(state.settings.branch)}?recursive=1`);
    const items = (tree.tree || []).filter(
      (t) => t.type === 'blob' && t.path.startsWith(prefix) && /\.md$/i.test(t.path),
    );

    state.posts = items.map((t) => {
      const rel = t.path.slice(prefix.length);
      const parts = rel.split('/');
      return {
        name: parts[parts.length - 1],
        path: t.path,
        sha: t.sha,
        folder: parts.slice(0, -1).join('/'),
      };
    }).sort((a, b) => b.name.localeCompare(a.name) || a.path.localeCompare(b.path));

    // 合并本地存档：本地新增的文章也要出现在列表里
    await refreshLocalDiff(tree.tree || [], items);
    await applyLocalOrder();

    renderList();
    const diffCount = [...(state.diff?.values() || [])].filter((v) => v.status !== 'same').length;
    setStatus(`已连接 ${repo.fullName} · ${state.posts.length} 篇文章`
      + (diffCount ? ` · ${diffCount} 个本地改动` : '') + branchWarn);
    enrichTitles();
  } catch (e) {
    // 空仓库：GitHub 读文件树返回 409「Git Repository is empty」，按空列表处理
    const isEmptyRepo = e.status === 404 || (e.status === 409 && /empty/i.test(e.apiMessage || e.message || ''));
    if (isEmptyRepo) {
      state.posts = [];
      await refreshLocalDiff([], []);
      renderList();
      setStatus(`已连接 ${repo.fullName}，仓库还是空的${branchWarn}`);
      toast('仓库是空的，点「初始化 Hexo 站点」即可开始');
    } else if (e.status === 403) {
      setConn(false);
      toast(`仓库可读，但没有读取内容的权限：${e.message}`, true);
      setStatus(`无权限：${e.message}`);
    } else {
      setConn(false);
      toast(e.message, true);
      setStatus(`读取文章列表失败：${e.message}`);
    }
  }
}

/**
 * 汇总「本地存档 vs 仓库」的差异，写进 state.diff。
 * 同时把本地有、仓库没有的文章补进 state.posts（新增的文章要能在列表里看到）。
 */
/**
 * 不请求网络，用当前列表里已知的远程 sha 快速重算差异标记。
 * 自动保存后走这条，避免每次敲字都打一遍 GitHub API。
 */
async function refreshDiffFromState() {
  try {
    const localFiles = await localStore.listLocal();
    if (!state.deletedPaths) state.deletedPaths = new Set();
    state.deletedPaths = new Set(localFiles.filter((f) => f.deleted).map((f) => f.path));
    const remoteShaMap = new Map();
    for (const p of state.posts) {
      if (p.path && p.sha) remoteShaMap.set(p.path, p.sha);
    }
    state.diff = localStore.computeStatus(localFiles, remoteShaMap);
    renderList();
  } catch (e) { console.warn("刷新差异标记失败", e); }
}

/**
 * 严格比对：把本地每个文件的内容和仓库里的同名文件真比一遍。
 * 只看内容 hash，完全不管 baseSha / baseHash 这类历史标记——「刷新」按钮用它做全局检查。
 */
async function strictCompare() {
  const branch = encodeURIComponent(state.settings.branch);
  const tree = await gh(`/git/trees/${branch}?recursive=1`);
  const remoteBlobs = new Map();
  for (const t of (tree.tree || [])) {
    if (t.type === "blob") remoteBlobs.set(t.path, t.sha);
  }

  const localFiles = await localStore.listLocal();
  const status = new Map();
  let checked = 0;

  await pool(localFiles, 4, async (rec) => {
    const sha = remoteBlobs.get(rec.path);
    if (rec.deleted) {
      if (sha) status.set(rec.path, { status: "deleted", rec });
      return;
    }
    if (!sha) {
      status.set(rec.path, { status: "added", rec });
      return;
    }
    try {
      const blob = await gh(`/git/blobs/${sha}`);
      const remoteContent = rec.isBinary ? blob.content : b64decodeUtf8(blob.content);
      const same = localStore.hashContent(remoteContent) === localStore.hashContent(rec.content);
      status.set(rec.path, { status: same ? "same" : "modified", rec });
    } catch {
      status.set(rec.path, { status: "modified", rec });
    }
    checked++;
    if (checked % 8 === 0) setStatus(`正在比对 ${checked}/${localFiles.length}…`);
  });

  state.diff = status;
  renderList();
  return status;
}

/**
 * 从本地存档里读出 order，重排 state.posts。
 * 刷新列表后如果本地调过序，顺序要保持住，不然一刷新就回去了。
 */
async function applyLocalOrder() {
  try {
    const localFiles = await localStore.listLocal();
    const orderMap = new Map();
    for (const rec of localFiles) {
      if (!rec.content) continue;
      const m = /^order:\s*(\d+)\s*$/m.exec(rec.content);
      if (m) orderMap.set(rec.path, Number(m[1]));
    }
    if (!orderMap.size) return;
    state.posts.sort((a, b) => {
      const ao = orderMap.has(a.path) ? orderMap.get(a.path) : Infinity;
      const bo = orderMap.has(b.path) ? orderMap.get(b.path) : Infinity;
      if (ao !== bo) return ao - bo;
      return String(a.path).localeCompare(String(b.path), "zh");
    });
  } catch (e) { console.warn("应用本地顺序失败", e); }
}

async function refreshLocalDiff(treeItems, remoteMdItems) {
  try {
    const localFiles = await localStore.listLocal();
    const remoteShaMap = new Map();
    for (const t of treeItems) {
      if (t.type === 'blob') remoteShaMap.set(t.path, t.sha);
    }
    state.diff = localStore.computeStatus(localFiles, remoteShaMap);

    // 本地新增的 md 补进列表
    const prefix = `${state.settings.postsPath.replace(/\/+$/, '')}/`;
    const known = new Set(state.posts.map((p) => p.path));
    for (const [path, info] of state.diff) {
      // 被标记删除的（比如从别的分类移走的原文件）也要在列表里占个位，显示删除线
      if (info.status === 'deleted') {
        if (!path.startsWith(prefix) || !/\.md$/i.test(path)) continue;
        if (known.has(path)) continue;
        const dparts = path.slice(prefix.length).split('/');
        state.posts.push({
          name: dparts[dparts.length - 1],
          path,
          sha: null,
          folder: dparts.slice(0, -1).join('/'),
          isDeletedPlaceholder: true,
        });
        continue;
      }
      if (info.status !== 'added' && info.status !== 'modified') continue;
      if (!path.startsWith(prefix) || !/\.md$/i.test(path)) continue;
      if (known.has(path)) {
        // 已存在的文章：把本地内容挂到列表项上，打开时可直接用
        const item = state.posts.find((p) => p.path === path);
        if (item) item.localContent = info.rec.content;
        continue;
      }
      const rel = path.slice(prefix.length);
      const parts = rel.split('/');
      state.posts.push({
        name: parts[parts.length - 1],
        path,
        sha: null,
        folder: parts.slice(0, -1).join('/'),
        localContent: info.rec.content,
      });
    }
    state.posts.sort((a, b) => b.name.localeCompare(a.name) || a.path.localeCompare(b.path));
  } catch (e) {
    console.warn('本地差异计算失败', e);
    state.diff = new Map();
  }
}

const TITLE_CACHE_KEY = 'blog-admin:titles:v2';

/**
 * URL 推算规则的版本号。
 * 每次改动「没有 permalink 时如何拼 URL」的逻辑就 +1，
 * 让缓存里由旧规则算出的值自动失效重算（front-matter 里写死的 permalink 不受影响）。
 */
const PERMALINK_RULE = 2;

function loadTitleCache() {
  try {
    state.titleCache = JSON.parse(localStorage.getItem(TITLE_CACHE_KEY) || '{}') || {};
  } catch { state.titleCache = {}; }
}

function saveTitleCache() {
  try { localStorage.setItem(TITLE_CACHE_KEY, JSON.stringify(state.titleCache)); } catch { /* 配额满就跳过 */ }
}

/** 批量读取 front-matter 里的标题，按文件 sha 缓存，避免每次刷新重读 */
async function enrichTitles() {
  const valid = new Set(state.posts.map((p) => p.path));
  for (const key of Object.keys(state.titleCache)) {
    if (!valid.has(key)) delete state.titleCache[key];
  }

  const todo = state.posts.filter((p) => {
    const c = state.titleCache[p.path];
    if (!c || c.sha !== p.sha || !c.permalink) return true;
    // 推算出来的 permalink 依赖规则版本；规则变了必须重算
    return !c.permalinkExplicit && c.permalinkRule !== PERMALINK_RULE;
  });
  if (!todo.length) { saveTitleCache(); renderList(); return; }

  let done = 0;
  setStatus(`读取文章标题 0/${todo.length}…`);
  await pool(todo, 4, async (p) => {
    const { text } = await getFile(p.path);
    const { data } = splitFrontMatter(text);
    const dt = parseDateValue(data.date) || new Date();
    const y = dt.getFullYear();
    const mo = pad2(dt.getMonth() + 1);
    const da = pad2(dt.getDate());
    // 没有 permalink 字段时，Hexo 用的是「相对 _posts 的完整路径」作为 :title
    const fullName = p.name.replace(/\.md$/i, '');
    const folder = p.folder ? `${p.folder}/` : '';

    state.titleCache[p.path] = {
      sha: p.sha,
      title: data.title ? String(data.title) : '',
      permalink: data.permalink ? String(data.permalink) : `${y}/${mo}/${da}/${folder}${fullName}/`,
      permalinkExplicit: !!data.permalink,
      permalinkRule: PERMALINK_RULE,
      date: `${y}-${mo}-${da}`,
      tags: toList(data.tags),
      categories: toList(data.categories),
    };
    done++;
    if (done % 5 === 0 || done === todo.length) setStatus(`读取文章标题 ${done}/${todo.length}…`);
  });
  saveTitleCache();
  renderList();
  setStatus(`共 ${state.posts.length} 篇文章`);
}

async function openPost(item) {
  setStatus(`读取 ${item.name}…`);

  // 本地有改动时优先打开本地版本（未上传的编辑不能丢）
  let text;
  let sha = item.sha;
  const local = await localStore.getLocal(item.path);
  let restored = false;
  if (local && local.deleted) {
    // 点开被标记删除的文章 = 撤销删除
    await localStore.putLocal(item.path, local.content);
    if (state.diff) state.diff.delete(item.path);
    if (state.deletedPaths) state.deletedPaths.delete(item.path);
    item.isDeletedPlaceholder = false;
    restored = true;
  }
  if (local && !local.deleted) {
    text = local.content;
    setStatus(`读取本地版本 ${item.name}…`);
  } else if (local && local.deleted) {
    text = local.content;
  } else {
    const remote = await getFile(item.path);
    text = remote.text;
    sha = remote.sha;
    // 首次打开时把远程内容缓存到本地，并标记为「已同步」，
    // 这样只是打开看看不会被误标成有改动
    await localStore.putLocal(item.path, text, { markSynced: true, baseSha: sha });
  }

  const { data, body } = splitFrontMatter(text);

  fillForm({
    title: data.title ? String(data.title) : item.name.replace(/\.md$/i, ''),
    date: parseDateValue(data.date) || new Date(),
    categories: toList(data.categories),
    tags: toList(data.tags),
    draft: data.draft === true,
    excerpt: data.excerpt ? String(data.excerpt) : '',
    password: data.password ? String(data.password) : '',
    slug: '',
  });
  editor.value(body);

  markEditorClean();
  markAutoSaveBaseline();
  state.current = { path: item.path, sha, permalink: data.permalink ? String(data.permalink) : null };
  if (restored) { renderList(); setStatus(`已恢复《${item.name}》`); }
  $$('#postList li').forEach((li) => li.classList.remove('active'));
  renderList();
  setStatus(`已打开 ${item.name}`);
}

function setConn(ok) {
  const dot = $('#connDot');
  dot.classList.remove('ok', 'bad');
  if (ok === true) dot.classList.add('ok');
  else if (ok === false) dot.classList.add('bad');
  dot.title = ok === true ? '已连接' : ok === false ? '连接失败' : '连接中…';
}

/* ============================================================
 *  图片上传（仓库即图床）
 * ============================================================ */
async function optimizeImage(file) {
  if (file.type === 'image/gif') return file;
  if (file.type === 'image/svg+xml') return file;

  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }

  const MAX_W = 1600;
  const scale = Math.min(1, MAX_W / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);

  let blob = null;
  try {
    if (canvas.convertToBlob) {
      blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
    } else {
      blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.85));
    }
  } catch { /* ignore */ }

  // WebP 压缩没变小时，退回原图
  if (!blob || blob.size >= file.size) return file;
  return blob;
}

async function uploadImage(file) {
  if (!settingsReady()) throw new Error('请先在设置里配置仓库和 Token');
  const s = state.settings;

  const blob = await optimizeImage(file);
  const now = new Date();
  const y = now.getFullYear();
  const m = pad2(now.getMonth() + 1);
  const ext = blob.type === 'image/webp' ? 'webp'
    : blob.type === 'image/png' ? 'png'
      : blob.type === 'image/gif' ? 'gif'
        : blob.type === 'image/svg+xml' ? 'svg'
          : 'jpg';
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const path = `${s.imagesPath.replace(/\/+$/, '')}/${y}/${m}/${name}`;

  const b64 = await blobToBase64(blob);
  await gh(`/contents/${encPath(path)}`, {
    method: 'PUT',
    body: { message: `image: ${name}`, content: b64, branch: s.branch },
  });

  return `${s.imagePrefix.replace(/\/+$/, '')}/${y}/${m}/${name}`;
}

/* ============================================================
 *  导入 .md 时同步本地图片
 * ============================================================ */
const IMG_REF_RE = /!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;

/** 找出正文里指向本地文件的图片引用（排除外链、data:、站内绝对路径） */
function findLocalImageRefs(body) {
  const found = new Map();
  IMG_REF_RE.lastIndex = 0;
  let m;
  while ((m = IMG_REF_RE.exec(body)) !== null) {
    const path = m[2];
    if (!path) continue;
    if (/^(https?:)?\/\//i.test(path)) continue;
    if (/^(data|blob|mailto):/i.test(path)) continue;
    if (path.startsWith('/')) continue; // 站内绝对路径，视为已上传
    found.set(path, { path, alt: m[1] || '' });
  }
  return [...found.values()];
}

function showImageHint(text) {
  $('#imageHintText').textContent = text;
  $('#imageHint').hidden = !text;
}

async function uploadPendingImages(files) {
  const refs = state.pendingLocalImages || [];
  if (!refs.length || !files.length) return;
  if (!settingsReady()) { toast('请先配置仓库和 Token', true); return; }

  const byName = new Map();
  for (const f of files) {
    byName.set(f.name, f);
    try { byName.set(decodeURIComponent(f.name), f); } catch { /* 文件名不含转义时忽略 */ }
  }

  let body = editor.value();
  let ok = 0;
  const missing = [];

  for (const ref of refs) {
    const base = ref.path.split('/').pop().split('?')[0];
    let file = byName.get(base);
    if (!file) {
      try { file = byName.get(decodeURIComponent(base)); } catch { /* ignore */ }
    }
    if (!file) { missing.push(base); continue; }

    setStatus(`上传图片 ${ok + 1}/${refs.length}：${file.name}`);
    try {
      const url = await uploadImage(file);
      body = body.split(ref.path).join(url);
      ok++;
    } catch (e) {
      toast(`上传 ${file.name} 失败：${e.message}`, true);
    }
  }

  editor.value(body);

  const remaining = refs.filter((r) => body.includes(r.path));
  state.pendingLocalImages = remaining;
  if (remaining.length) {
    showImageHint(`还有 ${remaining.length} 张图片没有匹配到对应文件，可再次选择或手动处理`);
  } else {
    showImageHint('');
  }

  const parts = [`已上传 ${ok} 张`];
  if (missing.length) parts.push(`${missing.length} 张未找到文件`);
  toast(parts.join('，'));
  setStatus(`图片上传完成：${ok}/${refs.length}`);
}

/** 图片扩展名 */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)(?=$|[?#])/i;

/** 常见可下载文件的扩展名（判断 URL 路径尾部，忽略 query） */
const FILE_EXTS = [
  // 压缩包
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lz4', 'lzh', 'z', 'cab',
  // 文档
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp', 'rtf',
  'epub', 'mobi', 'azw3', 'pages', 'key', 'numbers',
  // 文本 / 代码
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'log',
  'cpp', 'hpp', 'cc', 'cxx', 'c', 'h', 'py', 'pyw', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
  'java', 'kt', 'kts', 'go', 'rs', 'rb', 'php', 'lua', 'pl', 'r', 'm', 'mm', 'swift', 'scala', 'cs', 'vb', 'asm', 's',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'vbs',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
  'sql', 'db', 'sqlite', 'mdb',
  // 音视频
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'opus', 'm4a', 'wma', 'ape',
  // 安装包 / 二进制
  'apk', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'jar', 'war', 'class', 'pyc',
  'iso', 'img', 'bin', 'dat',
  // 字体
  'ttf', 'otf', 'woff', 'woff2', 'eot',
];
const FILE_EXT_RE = new RegExp(`\\.(${FILE_EXTS.join('|')})(?=$|[?#])`, 'i');

/**
 * 汇总正文里的全部外链资源，并给出归类：
 * - 出现在 ![]() 或 <img src> 里的一律当图片
 * - 出现在 [text](url) 或 <a href> 里的按扩展名判断（图片 → image，其余命中文件后缀 → file）
 */
function findExternalRefs(body) {
  const found = new Map();
  const add = (url, kind, text) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (!found.has(url)) found.set(url, { url, kind, text: text || '' });
  };

  let m;

  IMG_REF_RE.lastIndex = 0;
  while ((m = IMG_REF_RE.exec(body)) !== null) add(m[2], 'image', m[1]);

  // 博客园导出的文章里常见 <img src="...">，只扫 ![]() 会漏
  const imgRe = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = imgRe.exec(body)) !== null) add(m[1], 'image', '');

  // URL 里允许成对括号（文件名可能带 (1) 之类），原来的 [^)>\s]+ 会在第一个 ) 处截断
  const linkRe = /(?<!!)\[([^\]]*)\]\(\s*<?((?:[^()\s]|\([^()]*\))+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  while ((m = linkRe.exec(body)) !== null) {
    const url = m[2];
    if (IMAGE_EXT_RE.test(url)) add(url, 'image', m[1]);
    else if (FILE_EXT_RE.test(url)) add(url, 'file', m[1]);
  }

  // 裸链接：正文里直接贴的 URL（云盘分享常用），只认已知文件扩展名，避免误伤普通网址
  const bareRe = new RegExp(`https?://[^\\s<>\"'\\])]+?\\.(${FILE_EXTS.join('|')})(?=$|[?#\\s<>])`, 'gi');
  while ((m = bareRe.exec(body)) !== null) add(m[0], 'file', '');

  const aRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = aRe.exec(body)) !== null) {
    const url = m[1];
    const text = (m[2] || '').replace(/<[^>]+>/g, '');
    if (IMAGE_EXT_RE.test(url)) add(url, 'image', text);
    else if (FILE_EXT_RE.test(url)) add(url, 'file', text);
  }

  return [...found.values()];
}

/** 把二进制文件上传到仓库的 files 目录（非图片附件） */
/**
 * 上传附件到 source/files/年/月/，返回可访问的 URL。
 * 和图片上传的区别：这个不要求 blob.type 是图片，而且插入的是普通链接。
 */
async function uploadAttachment(file) {
  if (!settingsReady()) { toast('请先配置仓库', true); return null; }

  const now = new Date();
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  // 只处理路径分隔符和 Windows 非法字符，中文原样保留
  const safe = String(file.name || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'file';
  const path = `source/files/${y}/${mo}/${safe}`;

  const b64 = await blobToBase64(file);

  // 同名文件已存在时必须带 sha 才能覆盖
  let existSha = null;
  try {
    const exist = await gh(`/contents/${encPath(path)}?ref=${encodeURIComponent(state.settings.branch)}`);
    if (exist && exist.sha) existSha = exist.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const body = { message: `file: ${safe}`, content: b64, branch: state.settings.branch };
  if (existSha) body.sha = existSha;

  await gh(`/contents/${encPath(path)}`, { method: 'PUT', body });

  const site = deriveSite();
  const root = String(site.root || '/').replace(/\/$/, '');
  return `${root}/files/${y}/${mo}/${safe}`;
}

/** 上传一批附件，并把 Markdown 下载链接插到光标处 */
async function uploadAttachments(files) {
  if (!files || !files.length) return;
  if (!settingsReady()) { toast('请先配置仓库', true); return; }

  const btn = $(`#btnAttach`);
  if (btn) btn.disabled = true;

  const lines = [];
  const failed = [];

  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setStatus(`上传附件 ${i + 1}/${files.length}：${f.name}…`);
      try {
        const url = await uploadAttachment(f);
        if (url) lines.push(`[${f.name}](${url})`);
      } catch (e) {
        failed.push(`${f.name}：${e.message}`);
      }
    }

    if (lines.length) {
      const cm = editor.codemirror;
      const block = (editor.value().endsWith('\n') ? '' : '\n') + lines.join('\n') + '\n';
      // 插到文末，不然会插在用户当时的光标位置（可能是开头）
      cm.setCursor({ line: cm.lineCount(), ch: 0 });
      cm.replaceSelection(block);
      scheduleAutoSave();
    }

    if (failed.length) {
      showTextDialog({
        title: `${lines.length} 个成功，${failed.length} 个失败`,
        hint: '成功的已插入下载链接并自动保存到本地；失败的可以重试。',
        text: failed.join('\n'),
      });
    } else if (lines.length) {
      toast(`已上传 ${lines.length} 个附件并插入链接`);
    }
    setStatus(lines.length ? `附件上传完成（${lines.length} 个）` : '附件上传失败');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function uploadBinaryFile(blob, name) {
  const s = state.settings;
  const site = deriveSite();
  const now = new Date();
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  const safe = String(name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'file';
  const path = `source/files/${y}/${mo}/${safe}`;

  const b64 = await blobToBase64(blob);

  // 同名文件已存在时必须带 sha 才能覆盖
  let existSha = null;
  try {
    const exist = await gh(`/contents/${encPath(path)}?ref=${encodeURIComponent(s.branch)}`);
    if (exist && exist.sha) existSha = exist.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const body = { message: `file: ${safe}`, content: b64, branch: s.branch };
  if (existSha) body.sha = existSha;

  await gh(`/contents/${encPath(path)}`, { method: 'PUT', body });

  return `${site.root.replace(/\/$/, '')}/files/${y}/${mo}/${safe}`;
}

/**
 * 下载外链资源并上传到仓库：
 * - 图片 → source/images/年/月/，路径 /images/...
 * - 其他可下载文件 → source/files/年/月/，路径 /files/...
 * 下载失败的保留原地址，并汇总到 failed 里。
 */
/**
 * 扫描正文里的「非外链」文件引用：相对路径、站内绝对路径。
 * 这类链接没法自动下载（本来就在仓库里，或者本地磁盘上），
 * 但可以检查它在仓库里到底存不存在，帮用户定位问题。
 */
function findLocalRefs(body) {
  const out = [];
  const seen = new Set();
  const push = (url, text, kind) => {
    if (!url || seen.has(url)) return;
    if (/^(https?:)?\/\//i.test(url)) return;   // 外链，已由 findExternalRefs 处理
    if (url.startsWith('#')) return;              // 页内锚点
    seen.add(url);
    out.push({ url, text: text || '', kind });
  };

  let m;
  const mdRe = /(?<!!)\[([^\]]*)\]\(\s*<?((?:[^()\s]|\([^()]*\))+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  while ((m = mdRe.exec(body)) !== null) push(m[2], m[1], 'markdown');

  const aRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = aRe.exec(body)) !== null) push(m[1], (m[2] || '').replace(/<[^>]+>/g, ''), 'html');

  return out;
}

/**
 * 把站内路径换算成仓库里的实际路径。
 * 支持 ./x、../x、/blog/files/x、/files/x 这几种写法。
 */
function localRefToRepoPath(url) {
  let p = String(url).split('?')[0].split('#')[0];

  // file:/// 这种是本地磁盘路径，网页上根本访问不到，单独标出来
  if (/^file:/i.test(p)) return '(本地磁盘路径，无法迁移)';

  const site = deriveSite();
  const root = site.root || "/";
  if (p.startsWith(root)) p = p.slice(root.length);
  else if (p.startsWith('/')) p = p.replace(/^\/+/, '');
  else p = p.replace(/^\.\/+/, '');

  // 折叠 ../
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  return `source/${parts.join('/')}`.replace(/\/{2,}/g, '/');
}

/** 检查一组站内路径在仓库里是否存在，返回带状态的列表 */
async function checkLocalRefs(refs) {
  const out = [];
  for (const ref of refs) {
    const repoPath = localRefToRepoPath(ref.url);
    let exists = false;
    let note = '';
    try {
      const rec = await localStore.getLocal(repoPath);
      if (rec && !rec.deleted) { exists = true; note = '本地有'; }
      else {
        await gh(`/contents/${encPath(repoPath)}?ref=${encodeURIComponent(state.settings.branch)}`);
        exists = true; note = '仓库有';
      }
    } catch (e) {
      note = e.status === 404 ? '仓库里没有' : `检查失败（${e.message}）`;
    }
    out.push({ ...ref, repoPath, exists, note });
  }
  return out;
}

async function migrateExternalImages(body, onProgress) {
  const refs = findExternalRefs(body);
  const failed = [];
  let ok = 0;
  let out = body;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const url = ref.url;
    if (onProgress) onProgress(i + 1, refs.length, url);

    try {
      const res = await fetch(url, { referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();

      const baseName = decodeURIComponent((url.split('/').pop() || '').split('?')[0].split('#')[0]) || 'file';

      let newUrl;
      if (ref.kind === 'image') {
        if (!blob.type.startsWith('image/')) throw new Error(`不是图片（${blob.type || '未知类型'}）`);
        const file = new File([blob], baseName, { type: blob.type });
        newUrl = await uploadImage(file);
      } else {
        if (blob.size === 0) throw new Error('文件为空');
        newUrl = await uploadBinaryFile(blob, baseName);
      }

      out = out.split(url).join(newUrl);
      ok++;
    } catch (e) {
      failed.push({ url, kind: ref.kind, reason: e.message });
    }
  }

  return { body: out, ok, failed, total: refs.length };
}

function describeFailures(failed) {
  return failed
    .map((f) => `· [${f.kind === 'file' ? '文件' : '图片'}] ${f.url}\n  ${f.reason}`)
    .join('\n');
}

async function importMarkdown(file) {
  const text = await file.text();
  const { data, body } = splitFrontMatter(text);
  const baseName = file.name.replace(/\.(md|markdown|txt)$/i, '');

  fillForm({
    title: data.title ? String(data.title) : baseName,
    date: parseDateValue(data.date) || new Date(),
    categories: toList(data.categories),
    tags: toList(data.tags),
    draft: data.draft === true,
    excerpt: data.excerpt ? String(data.excerpt) : '',
    password: data.password ? String(data.password) : '',
    slug: '',
  });
  editor.value(body);
  state.current = { path: null, sha: null, permalink: null };

  // 先把外链图片下载进仓库，避免依赖别人的图床
  const external = findExternalRefs(body);
  if (external.length && settingsReady()) {
    setStatus(`正在下载 ${external.length} 张外链图片…`);
    const res = await migrateExternalImages(body, (i, total) => {
      setStatus(`迁移外链图片 ${i}/${total}…`);
    });
    editor.value(res.body);
    if (res.failed.length) {
      showTextDialog({
        title: `${res.failed.length} 张图片下载失败`,
        hint: `已成功迁移 ${res.ok}/${res.total} 张，失败的保留原地址，可以稍后点「迁移图片」重试。`,
        text: describeFailures(res.failed),
      });
    } else if (res.ok) {
      toast(`已把 ${res.ok} 张外链图片下载进仓库`);
    }
  }

  const locals = findLocalImageRefs(editor.value());
  state.pendingLocalImages = locals;
  if (locals.length) {
    showImageHint(`文档引用了 ${locals.length} 张本地图片，尚未上传到仓库`);
    setStatus(`已导入 ${file.name}，发现 ${locals.length} 张本地图片`);
    toast(`导入成功，可一并上传 ${locals.length} 张图片`);
  } else {
    showImageHint('');
    setStatus(`已导入 ${file.name}，可直接发布`);
    toast('导入成功，检查无误后点击发布');
  }
}

/**
 * 对已发布的文章批量执行「外链图片下载进仓库」，一次提交。
 */
/**
 * 只迁移「当前打开这篇文章」的外链资源。
 * 不再全仓库扫描：失败重跑时不会把已经成功的一起再跑一遍。
 * 结果写回本地，由用户自己决定什么时候上传。
 */
async function migrateCurrentPost() {
  if (!settingsReady()) { toast('请先配置仓库', true); return; }

  const path = state.current && state.current.path;
  if (!path) { toast('请先打开一篇文章', true); return; }

  const btn = $('#btnMigrateImages');
  if (btn) btn.disabled = true;
  setStatus('扫描当前文章的外链…');

  try {
    let text;
    const local = await localStore.getLocal(path);
    if (local && !local.deleted && local.content) text = local.content;
    else text = (await getFile(path)).text;

    const { body } = splitFrontMatter(text);
    const refs = findExternalRefs(body);

    if (!refs.length) {
      // 没有 http(s) 外链时，把站内/相对路径引用也查一遍，帮用户搞清楚到底缺什么
      const localRefs = findLocalRefs(body);
      if (!localRefs.length) {
        toast('这篇文章没有任何链接引用（外链和站内都没有）');
        setStatus('无需迁移');
        return;
      }
      setStatus(`检查 ${localRefs.length} 个站内引用…`);
      const checked = await checkLocalRefs(localRefs);
      const lines = checked.map((x) => (x.exists ? '✓' : '✗') + ` ${x.url}\n    → 仓库路径：${x.repoPath}（${x.note}）`);
      showTextDialog({
        title: '没有可迁移的外链',
        hint: '「迁移外链」只处理 http(s) 开头的外链。下面这些是站内/相对路径，没法自动下载——\n如果要它们能访问，文件必须真实存在于仓库里。',
        text: lines.join('\n\n'),
      });
      setStatus('没有外链；已列出站内引用');
      return;
    }

      setStatus(`发现 ${refs.length} 个外链，开始迁移…`);
    const res = await migrateExternalImages(body, (i, total, url) => {
      setStatus(`迁移 ${i}/${total}：${String(url).slice(0, 40)}…`);
    });

    if (res.ok > 0) {
      // 只替换正文部分，front-matter 原样保留
      const idx = text.indexOf(body);
      const newText = idx >= 0 ? text.slice(0, idx) + res.body : text;
      await localStore.putLocal(path, newText);

      // 编辑器同步成迁移后的内容
      const item = state.posts.find((p) => p.path === path) || { path, name: path.split('/').pop(), sha: null };
      item.localContent = newText;
      await openPost(item);
    }

    if (res.failed.length) {
      showTextDialog({
        title: `成功 ${res.ok} 个，失败 ${res.failed.length} 个`,
        hint: '成功的已替换为仓库地址并保存到本地；失败的保留原链接，可以稍后重试。',
        text: describeFailures(res.failed),
      });
      setStatus(`迁移完成：成功 ${res.ok}，失败 ${res.failed.length}`);
    } else {
      toast(`已迁移 ${res.ok} 个外链（保存在本地，点「↑ 仓库」上传）`);
      setStatus(`迁移完成：${res.ok} 个`);
    }
  } catch (e) {
    toast(`迁移失败：${e.message}`, true);
    setStatus(`迁移失败：${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function migrateAllPostsImages() {
  if (!settingsReady()) { toast('请先配置仓库', true); return; }
  if (!state.posts.length) { toast('还没有文章', true); return; }

  const btn = $('#btnMigrateImages');
  btn.disabled = true;
  setStatus('扫描文章里的外链图片…');

  const failedAll = [];
  const changes = [];
  let migrated = 0;
  let scanned = 0;

  try {
    for (const post of state.posts) {
      let text;
      try {
        // 本地有未上传的改动时以本地为准，否则刚写还没提交的文章根本扫不到
        const local = await localStore.getLocal(post.path);
        if (local && !local.deleted && local.content) {
          text = local.content;
        } else {
          text = (await getFile(post.path)).text;
        }
      } catch { continue; }
      scanned++;

      const { body } = splitFrontMatter(text);
      const refs = findExternalRefs(body);
      if (!refs.length) continue;

      setStatus(`处理 ${post.name}（${refs.length} 张）…`);
      const res = await migrateExternalImages(body, (i, total) => {
        setStatus(`${post.name}：${i}/${total}…`);
      });

      if (res.ok) {
        // 只替换正文部分，front-matter 原样保留
        const idx = text.indexOf(body);
        const newText = idx >= 0 ? text.slice(0, idx) + res.body : text;
        changes.push({ path: post.path, content: newText });
        migrated += res.ok;
      }
      res.failed.forEach((f) => failedAll.push({ post: post.name, ...f }));
    }

    if (!changes.length) {
      toast(failedAll.length ? '没有图片迁移成功' : '所有文章都没有外链图片');
      setStatus(`扫描 ${scanned} 篇，无需迁移`);
      if (failedAll.length) {
        showTextDialog({
          title: `${failedAll.length} 张图片下载失败`,
          hint: '这些图片保留原地址，稍后可以重试。',
          text: failedAll.map((f) => `· 《${f.post}》\n  ${f.url}\n  ${f.reason}`).join('\n'),
        });
      }
      return;
    }

    setStatus(`提交 ${changes.length} 篇文章…`);
    await commitFiles(changes, `chore: 迁移外链图片（${migrated} 张）`);

    if (failedAll.length) {
      showTextDialog({
        title: `已迁移 ${migrated} 张，${failedAll.length} 张失败`,
        hint: '失败的文章已经提交成功部分的替换，剩余的保留原地址。',
        text: failedAll.map((f) => `· 《${f.post}》\n  ${f.url}\n  ${f.reason}`).join('\n'),
      });
    } else {
      toast(`已迁移 ${migrated} 张图片，涉及 ${changes.length} 篇文章`);
    }
    setStatus(`已迁移 ${migrated} 张图片`);
    await loadPosts();
  } catch (e) {
    toast(`迁移失败：${e.message}`, true);
    setStatus(`迁移失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
 *  发布 / 删除
 * ============================================================ */
/**
 * 确认仓库能真正加密文章：
 *   1. package.json 装了 hexo-blog-encrypt
 *   2. 站点 _config.yml 有 encrypt: 段（插件只读这里，主题配置不算）
 * 缺哪项补哪项，返回是否可用（false 表示还没初始化 Hexo）。
 */
async function ensureEncryptPlugin() {
  let file;
  try {
    file = await getFile('package.json');
  } catch {
    return false;   // 还没初始化 Hexo
  }

  let pkg;
  try {
    pkg = JSON.parse(file.text);
  } catch {
    return false;
  }

  if (!pkg.dependencies || !pkg.dependencies['hexo-blog-encrypt']) {
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies['hexo-blog-encrypt'] = '^4.1.0';
    await putFile('package.json', `${JSON.stringify(pkg, null, 2)}\n`, 'chore: 启用文章加密插件', file.sha);
    toast('已为仓库启用加密插件 hexo-blog-encrypt');
  }

  // 已有站点不会重新初始化，所以这里也要把 encrypt 段补进站点 _config.yml，
  // 否则 autoSave / stableSalt 都是默认 false，刷新就要重新输密码。
  try {
    const cfgFile = await getFile('_config.yml');
    if (!/^encrypt:/m.test(cfgFile.text)) {
      const block = [
        '',
        '# 文章加密（hexo-blog-encrypt）',
        'encrypt:',
        '  abstract: 这是一篇加密文章，请输入访问密码',
        '  message: 请输入访问密码',
        '  wrong_pass_message: 密码不正确，请重试',
        '  theme: default',
        '  # 记住密码：密钥存 localStorage，同一篇再访问不用重复输入',
        '  autoSave: true',
        '  # salt 跟 permalink 绑定；否则每次构建 salt 变化会让缓存全部失效',
        '  stableSalt: true',
        '  kdf:',
        '    iterations: 600000',
        '',
      ].join('\n');
      const next = `${cfgFile.text.replace(/\s*$/, '')}\n${block}`;
      await putFile('_config.yml', next, 'config: 启用文章加密与密码缓存', cfgFile.sha);
      toast('已把 encrypt 配置写入站点 _config.yml');
    }
  } catch { /* 没有站点配置就跳过 */ }

  return true;
}

/* ============================================================
 *  本地存档：下载 / 导入 / 保存 / 批量上传
 * ============================================================ */

const TEXT_EXT = /\.(md|markdown|txt|yml|yaml|json|js|css|html?)$/i;

function fmtStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** 把仓库 source/ 下所有文件打包成 zip 下载 */
async function downloadSourceArchive() {
  if (!settingsReady()) { toast('请先配置仓库', true); return; }
  if (typeof JSZip === 'undefined') { toast('打包库没加载（vendor/jszip.min.js）', true); return; }

  const btn = $('#btnPullArchive');
  btn.disabled = true;
  setStatus('正在读取仓库文件列表…');

  try {
    const branch = encodeURIComponent(state.settings.branch);
    const tree = await gh(`/git/trees/${branch}?recursive=1`);
    const blobs = (tree.tree || []).filter((t) => t.type === 'blob' && t.path.startsWith('source/'));

    if (!blobs.length) { toast('仓库里没有 source/ 目录', true); return; }

    const zip = new JSZip();
    let done = 0;

    await pool(blobs, 4, async (b) => {
      try {
        const blob = await gh(`/git/blobs/${b.sha}`);
        if (blob && blob.content) {
          zip.file(b.path, blob.content, { base64: true });
        }
      } catch { /* 单个文件失败不影响整体 */ }
      done++;
      if (done % 5 === 0) setStatus(`正在下载 ${done}/${blobs.length}…`);
    });

    setStatus('正在打包…');
    const out = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    saveBlob(out, `blog-source-${fmtStamp()}.zip`);
    toast(`已打包 ${blobs.length} 个文件`);
    setStatus(`存档已下载（${blobs.length} 个文件）`);
  } catch (e) {
    toast(`下载失败：${e.message}`, true);
    setStatus(`下载失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** 导入本地存档 zip 到 IndexedDB */
async function importArchive(file) {
  if (typeof JSZip === 'undefined') { toast('打包库没加载', true); return; }

  const btn = $('#btnImportArchive');
  btn.disabled = true;
  setStatus('正在读取存档…');

  try {
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    if (!names.length) { toast('存档里没有文件', true); return; }

    const records = [];
    let done = 0;

    for (const name of names) {
      const entry = zip.files[name];
      const path = name.replace(/^\.\//, '');
      const isText = TEXT_EXT.test(path);
      const content = isText
        ? await entry.async('string')
        : await entry.async('base64');

      records.push({
        path,
        content,
        isBinary: !isText,
        deleted: false,
        ctime: entry.date ? entry.date.getTime() : Date.now(),
        mtime: entry.date ? entry.date.getTime() : Date.now(),
        baseSha: null,
        baseHash: null,   // 未知 base，按「新增」处理，等首次上传后回填
      });

      done++;
      if (done % 10 === 0) setStatus(`正在解压 ${done}/${names.length}…`);
    }

    await localStore.bulkPutLocal(records);
    toast(`已导入 ${records.length} 个文件到本地存档`);
    setStatus(`存档导入完成（${records.length} 个文件）`);
    await loadPosts();
  } catch (e) {
    toast(`导入失败：${e.message}`, true);
    setStatus(`导入失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** 保存当前编辑内容到本地（不上传） */
/**
 * 按标题推出文件名：保留原文件的日期前缀，其余用 slug(标题)。
 * 返回 null 表示不需要改（标题推不出有效 slug，或已经一致）。
 */
function fileNameForTitle(oldPath, title) {
  const base = String(title || '').trim();
  if (!base || base === '未命名') return null;
  const slug = slugify(base);
  if (!slug) return null;
  const oldFileName = String(oldPath).split('/').pop();
  const datePrefix = (/^(\d{4}-\d{2}-\d{2})/.exec(oldFileName) || [])[1] || '';
  const expected = datePrefix ? `${datePrefix}-${slug}.md` : `${slug}.md`;
  if (expected === oldFileName) return null;
  return treeOps.renameFile(oldPath, expected);
}

async function saveLocal({ silent = false, refresh = true } = {}) {
  const doc = collectForm();
  // 自动保存（silent）允许还没想好标题，先按「未命名」落盘
  if (!doc.title) {
    if (!silent) { toast('请先填写标题', true); return false; }
    doc.title = '未命名';
  }

  let path = state.current.path;
  if (!path) {
    const s = state.settings;
    const postsPath = (s.postsPath || 'source/_posts').replace(/\/+$/, '');
    const when = doc.date instanceof Date ? doc.date : new Date();
    const y = when.getFullYear();
    const mo = String(when.getMonth() + 1).padStart(2, '0');
    const da = String(when.getDate()).padStart(2, '0');
    const folder = doc.categories.length ? doc.categories.map(sanitizeFolder).join('/') : UNCATEGORIZED;
    const base = doc.slug || slugify(doc.title) || 'untitled';
    path = `${postsPath}/${folder}/${y}-${mo}-${da}-${base}.md`;
  }

  const content = buildFrontMatter({
    ...doc,
    excerpt: doc.excerpt || makeExcerpt(doc.body),
    disableNunjucks: /\{#/.test(doc.body),
    password: doc.password,
  }) + doc.body;

  // 分类改了就把文件搬到对应目录，和点「整理」的效果一致
  if (state.current.path && doc.categories.length) {
    const postsPath = (state.settings.postsPath || 'source/_posts').replace(/\/+$/, '');
    const relDir = doc.categories.map((x) => sanitizeFolder(x)).join('/');
    const expectedDir = postsPath + '/' + relDir;
    const curDir = treeOps.dirname(path);
    if (curDir !== expectedDir) {
      const movedPath = treeOps.moveInto(path, expectedDir);
      try {
        const actualMoved = await treeUI.relocateFile(path, movedPath, content, { sourceInRepo: !!state.current.sha });
        state.titleCache[actualMoved] = { ...(state.titleCache[path] || {}), title: doc.title, sha: null, categories: doc.categories };
        delete state.titleCache[path];
        saveTitleCache();

        recordMovedPlaceholder(path, state.current.sha, postsPath, content);
        // 已经在本地挪过位置了，后面的改名不该再产生一条删除占位
        if (state.current) state.current.sha = null;
        const movedItem = state.posts.find((p) => p.path === path);
        if (movedItem) {
          movedItem.path = actualMoved;
          movedItem.name = actualMoved.split('/').pop();
          movedItem.folder = relDir;
          movedItem.sha = null;
        }
        path = actualMoved;
      } catch (e) {
        console.warn('同步分类目录失败', e);
      }
    }
  }

  // 标题改了就把文件名一起改掉，保持「标题 ↔ 文件名」一致
  const renamed = fileNameForTitle(path, doc.title);
  if (renamed) {
    const oldPath = path;
    try {
      const actualRenamed = await treeUI.relocateFile(oldPath, renamed, content, { sourceInRepo: !!state.current.sha });
      state.titleCache[actualRenamed] = { ...(state.titleCache[oldPath] || {}), title: doc.title, sha: null };
      delete state.titleCache[oldPath];
      saveTitleCache();

      // 改名 = 删除 + 创建：原文件名显示为已删除
      recordMovedPlaceholder(oldPath, state.current.sha, (state.settings.postsPath || 'source/_posts').replace(/\/+$/, ''), content);

      // 列表里的条目也要跟着改，否则新旧路径会同时出现
      const postItem = state.posts.find((p) => p.path === oldPath);
      if (postItem) {
        postItem.path = actualRenamed;
        postItem.name = actualRenamed.split('/').pop();
        postItem.sha = null;
      }
      path = actualRenamed;
    } catch (e) {
      console.warn('同步文件名失败', e);
    }
  }

  await localStore.putLocal(path, content, { ctime: state.current.ctime });

  state.current.path = path;
  markEditorClean();
  markAutoSaveBaseline();
  if (!silent) {
    toast('已保存到本地（未上传）');
    setStatus(`本地已保存：${path.split('/').pop()}`);
  }
  if (refresh) await loadPosts();
  else await refreshDiffFromState();
  return true;
}

/** 把所有本地差异一次性上传 */
/**
 * 等 GitHub 的 git trees 反映最新提交。
 * commit 成功后 trees 常有 0.5~2 秒延迟，立刻刷新会把刚上传的文件判成「远程没有」。
 */
async function waitForRemotePaths(paths, tries = 8, delay = 500) {
  if (!paths.length) return true;
  const branch = encodeURIComponent(state.settings.branch);
  for (let i = 0; i < tries; i++) {
    try {
      const tree = await gh(`/git/trees/${branch}?recursive=1`);
      const set = new Set((tree.tree || []).filter((t) => t.type === "blob").map((t) => t.path));
      if (paths.every((p) => set.has(p))) return true;
    } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, delay));
  }
  return false;
}

async function pushAllDiff() {
  if (!settingsReady()) { toast('请先配置仓库', true); return; }

  const btn = $('#btnPushAll');
  btn.disabled = true;
  setStatus('正在比对本地与仓库…');

  try {
    const diff = state.diff || new Map();
    const entries = [...diff.entries()].filter(([, v]) => v.status !== 'same');
    if (!entries.length) { toast('没有需要上传的改动'); setStatus('没有差异'); return; }

    // 按本地创建时间升序，保证提交顺序符合书写顺序
    entries.sort((a, b) => (a[1].rec?.ctime || 0) - (b[1].rec?.ctime || 0));

    const preview = entries.slice(0, 6).map(([p, v]) => `${v.status === 'deleted' ? '删除' : v.status === 'added' ? '新增' : '修改'}  ${p.split('/').pop()}`).join('\n');
    const more = entries.length > 6 ? `\n…还有 ${entries.length - 6} 个` : '';
    if (!confirm(`将上传 ${entries.length} 个文件：\n\n${preview}${more}\n\n继续吗？`)) {
      setStatus('已取消'); return;
    }

    const changes = entries.map(([path, v]) => {
      if (v.status === 'deleted') return { path, sha: null };
      return { path, content: v.rec.content, base64: v.rec.isBinary ? v.rec.content : null };
    });

    setStatus(`正在提交 ${changes.length} 个文件…`);
    await commitFiles(changes, `chore: 上传本地改动（${changes.length} 个文件）`);

    // 上传成功后把这些文件标记为已同步
    for (const [path, v] of entries) {
      if (v.status === 'deleted') await localStore.removeLocal(path);
      else await localStore.putLocal(path, v.rec.content, { markSynced: true });
    }

    toast(`已上传 ${changes.length} 个文件（等待 Action 构建）`);
    setStatus(`已上传 ${changes.length} 个文件，等待构建…`);
    // 刻意不在这里 loadPosts：构建期间仓库页面上还是旧架构，
    // 立刻同步会让新建/移动的文件在列表里「消失一下」。
    // 等这次 Action 成功后再统一刷新（见 pollActionsOnce 里的 postDeployRefresh）。
  } catch (e) {
    toast(`上传失败：${e.message}`, true);
    setStatus(`上传失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function publish() {
  const doc = collectForm();
  if (!doc.title) { toast('请先填写标题', true); $('#fTitle').focus(); return; }
  if (!settingsReady()) { openSettings(); return; }
  if (!doc.body.trim()) { toast('正文是空的', true); return; }

  const s = state.settings;
  const btn = $('#btnPublish');

  // 定时发布：日期在未来时提醒需要定时构建
  if (doc.date.getTime() > Date.now() + 60 * 1000) {
    const when = doc.date.toLocaleString('zh-CN');
    const ok = confirm(
      `发布日期在未来（${when}）。\n\n`
      + '文章会以未来日期提交，仓库里需要有「定时构建」的 workflow 才会按时上线。\n'
      + '可在右上角设置里一键安装。\n\n现在提交吗？'
    );
    if (!ok) { setStatus('已取消'); return; }
  }

  btn.disabled = true;
  setStatus('正在提交到 GitHub…');

  try {
    let path = state.current.path;
    let sha = state.current.sha;
    let permalink = state.current.permalink || null;

    if (!path) {
      const y = doc.date.getFullYear();
      const mo = pad2(doc.date.getMonth() + 1);
      const da = pad2(doc.date.getDate());
      const datePart = `${y}-${mo}-${da}`;
      const slug = doc.slug || slugify(doc.title) || 'untitled';
      const base = /^\d{4}-\d{2}-\d{2}/.test(slug) ? slug : `${datePart}-${slug}`;
      const filename = `${base}.md`;

      // 按第一个分类建子目录；没有分类就放「临时」
      const folder = doc.categories.length ? sanitizeFolder(doc.categories[0]) : UNCATEGORIZED;
      path = `${s.postsPath.replace(/\/+$/, '')}/${folder}/${filename}`;

      // 固定 permalink，保证列表里的「打开文章」链接是准的；带上分类目录与站点结构保持一致
      const slugBase = base.replace(/^\d{4}-\d{2}-\d{2}-/, '');
      permalink = `${y}/${mo}/${da}/${folder}/${slugBase}/`;

      // 同名文件已存在则拒绝，避免覆盖
      try {
        const ex = await getFile(path);
        sha = ex.sha;
        if (!confirm(`文件 ${folder}/${filename} 已存在，要覆盖它吗？`)) {
          btn.disabled = false; setStatus('已取消'); return;
        }
      } catch { /* 不存在，正常 */ }
    }

    const content = buildFrontMatter({
      ...doc,
      // 没手填摘要就自动生成，避免列表页出现公式源码
      excerpt: doc.excerpt || makeExcerpt(doc.body),
      permalink,
      // 正文出现 {# 时（典型是 LaTeX 颜色）必须关掉 Nunjucks，否则 Hexo 构建失败
      disableNunjucks: /\{#/.test(doc.body),
      // 加密文章的摘要照常公开，显示在密码框上方
      abstract: doc.password ? (doc.excerpt || makeExcerpt(doc.body)) : '',
    }) + doc.body;

    // 加密文章必须先保证仓库装了插件，否则 password 字段会被忽略、正文按明文公开
    if (doc.password) {
      const ready = await ensureEncryptPlugin();
      if (!ready) {
        toast('加密需要仓库里的 package.json 包含 hexo-blog-encrypt，请先「初始化 Hexo 站点」', true);
        btn.disabled = false; setStatus('已取消：缺少加密插件'); return;
      }
    }

    // 已有文章：标题变了就把文件名一起改掉（新文章路径本来就是按标题生成的）
    if (state.current.path) {
      const renamed = fileNameForTitle(path, doc.title);
      if (renamed) {
        const oldPath = path;
        const actualPubRenamed = await treeUI.relocateFile(oldPath, renamed, content, { sourceInRepo: !!sha });
        state.titleCache[actualPubRenamed] = { ...(state.titleCache[oldPath] || {}), title: doc.title, sha: null };
        delete state.titleCache[oldPath];
        saveTitleCache();
        const postItem = state.posts.find((p) => p.path === oldPath);
        if (postItem) {
          postItem.path = actualPubRenamed;
          postItem.name = actualPubRenamed.split('/').pop();
          postItem.sha = null;
        }
        path = actualPubRenamed;
        sha = null;   // 新路径在仓库里还不存在
      }
    }

    const res = await putFile(path, content, `post: ${doc.title}`, sha || undefined, doc.title);

    // 已经直传仓库了，本地记录要同步，否则列表会一直挂着「有改动」
    try {
      await localStore.putLocal(path, content, {
        markSynced: true,
        baseSha: res?.content?.sha || null,
      });
    } catch { /* 本地标记失败不影响发布 */ }

    state.current = { path, sha: res.content.sha, permalink };
    markEditorClean();
    toast('提交成功（等待 Action 构建）');
    setStatus(`已提交：${path}`);

    await loadPosts();
  } catch (e) {
    toast(e.message, true);
    setStatus('发布失败');
  } finally {
    btn.disabled = false;
  }
}

async function removePost(item) {
  if (!confirm(`确定删除《${item.name}》？此操作会直接提交到仓库。`)) return;
  try {
    await deleteFile(item.path, item.sha, `delete: ${item.name}`);
    toast('已删除');
    if (state.current.path === item.path) newDocument(false);
    await loadPosts();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
 *  按分类整理到子目录
 * ============================================================ */
async function reorganizePosts() {
  if (!settingsReady()) { toast('请先配置仓库', true); return; }
  if (!state.posts.length) { toast('还没有文章', true); return; }

  const prefix = state.settings.postsPath.replace(/\/+$/, '');
  const btn = $('#btnOrganize');
  btn.disabled = true;
  setStatus('扫描文章分类…');

  const moves = [];
  try {
    await pool(state.posts, 3, async (p) => {
      let text;
      try { text = (await getFile(p.path)).text; } catch { return; }
      const { data } = splitFrontMatter(text);
      const cats = toList(data.categories);
      // 按完整分类层级建目录：笔记/数论 而不是只用最外层的 笔记
      const folder = cats.length
        ? cats.map((x) => sanitizeFolder(x)).join('/')
        : UNCATEGORIZED;
      const target = `${prefix}/${folder}/${p.name}`;
      if (target !== p.path) moves.push({ from: p.path, to: target, content: text });
    });

    if (!moves.length) {
      toast('所有文章已经在分类目录里');
      setStatus('无需整理');
      return;
    }

    const preview = moves.slice(0, 8).map((m) => `${m.from}  →  ${m.to}`).join('\n');
    const more = moves.length > 8 ? `\n…还有 ${moves.length - 8} 篇` : '';
    if (!confirm(`将移动 ${moves.length} 篇文章：\n\n${preview}${more}\n\n继续吗？`)) {
      setStatus('已取消');
      return;
    }

    // 目标路径已被别的文章占用时跳过，避免覆盖
    const occupied = new Set(state.posts.map((p) => p.path));
    const safe = moves.filter((m) => !occupied.has(m.to));
    if (!safe.length) { toast('目标位置都已被占用', true); return; }

    const changes = [];
    for (const m of safe) {
      changes.push({ path: m.from, sha: null });
      changes.push({ path: m.to, content: m.content });
    }

    setStatus(`正在移动 ${safe.length} 篇…`);
    await commitFiles(changes, `chore: 按分类整理 ${safe.length} 篇文章`);
    toast(`已移动 ${safe.length} 篇文章`);
    setStatus(`已移动 ${safe.length} 篇`);
    await loadPosts();
  } catch (e) {
    toast(`整理失败：${e.message}`, true);
    setStatus(`整理失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/**
 * 批量改分类：把「原分类」下所有文章整体挪到新的分类路径下。
 * 只改 front-matter 的 categories，文件位置、日期、正文、其他字段一律不动。
 */
async function batchMoveCategory() {
  if (!settingsReady()) { toast('请先配置仓库', true); return; }

  const from = $('#fCatFrom').value.trim();
  const to = $('#fCatTo').value.trim();
  if (!from || !to) { toast('填一下原分类和目标分类', true); return; }

  const toParts = to.split(/[\/,，]/).map((s) => s.trim()).filter(Boolean);
  if (!toParts.length) { toast('目标分类格式不对', true); return; }

  const btn = $('#btnMoveCategory');
  const result = $('#catMoveResult');
  btn.disabled = true;
  result.className = 'conn-result';
  result.textContent = '正在扫描文章…';

  try {
    if (!state.posts.length) await loadPosts();

    const changes = [];
    let scanned = 0;

    for (const p of state.posts) {
      let text;
      try { text = (await getFile(p.path)).text; } catch { continue; }
      scanned++;

      const { data } = splitFrontMatter(text);
      const cats = toList(data.categories);
      if (!cats.length || cats[0] !== from) continue;

      const next = insertCategoryPrefix(text, from, toParts);
      if (next !== text) changes.push({ path: p.path, content: next });
    }

    if (!changes.length) {
      result.textContent = `扫描 ${scanned} 篇，没有找到分类为「${from}」的文章`;
      return;
    }

    const target = toParts.join('/');
    if (!confirm(`将把 ${changes.length} 篇文章的分类从「${from}」改为「${target}」\n\n只改 front-matter 的 categories，文件位置和日期不动。继续吗？`)) {
      result.textContent = '已取消';
      return;
    }

    result.textContent = `找到 ${changes.length} 篇，正在提交…`;
    await commitFiles(changes, `chore: 分类 ${from} 迁移到 ${target}（${changes.length} 篇）`);

    result.textContent = `已把 ${changes.length} 篇从「${from}」迁到「${target}」`;
    result.className = 'conn-result ok';
    await loadPosts();
  } catch (e) {
    result.textContent = `迁移失败：${e.message}`;
    result.className = 'conn-result bad';
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
 *  定时构建 workflow（配合未来日期的定时发布）
 * ============================================================ */
const SCHEDULED_WORKFLOW_PATH = '.github/workflows/scheduled-rebuild.yml';

function buildScheduledWorkflow() {
  const buildStep = state.settings.framework === 'hugo'
    ? `      - name: Setup Hugo
        uses: peaceiris/actions-hugo@v3
        with:
          hugo-version: 'latest'
          extended: true
      - name: Build
        run: hugo --minify`
    : `      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install
        run: npm install
      - name: Build
        run: npx hexo generate`;

  return `name: Scheduled rebuild

on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${buildStep}
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./public

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;
}

async function installScheduledWorkflow() {
  if (!settingsReady()) { toast('请先填写仓库信息和 Token', true); return; }
  const btn = $('#btnInstallWorkflow');
  btn.disabled = true;
  try {
    let sha;
    try {
      sha = (await getFile(SCHEDULED_WORKFLOW_PATH)).sha;
    } catch { /* 文件不存在，属于正常情况 */ }

    if (sha && !confirm('仓库里已有同名 workflow，要覆盖吗？')) {
      setStatus('已取消');
      return;
    }

    await putFile(SCHEDULED_WORKFLOW_PATH, buildScheduledWorkflow(), 'ci: 定时构建以发布定时文章', sha);
    toast('已安装，站点会每小时自动重建一次');
    setStatus(`已提交 ${SCHEDULED_WORKFLOW_PATH}`);
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      const s = state.settings;
      showTextDialog({
        title: '需要 Workflows 权限',
        hint: `当前 token 没有修改 .github/workflows/ 的权限（${e.message}）。`
          + '要么给 token 勾上 Workflows: Read and write，要么点「在 GitHub 打开」用下面的内容手动新建文件。',
        text: buildScheduledWorkflow(),
        link: `https://github.com/${s.owner}/${s.repo}/new/${s.branch}`
          + `?filename=${encodeURIComponent(SCHEDULED_WORKFLOW_PATH)}`,
      });
      setStatus('缺少 Workflows 权限');
    } else {
      toast(e.message, true);
      setStatus('安装失败');
    }
  } finally {
    btn.disabled = false;
  }
}

function showTextDialog({ title, hint, text, link }) {
  $('#textDialogTitle').textContent = title;
  $('#textDialogHint').textContent = hint || '';
  $('#textDialogBody').value = text || '';
  const a = $('#textDialogLink');
  if (link) {
    a.href = link;
    a.hidden = false;
  } else {
    a.hidden = true;
  }
  const dlg = $('#textDialog');
  if (!dlg.open) dlg.showModal();
}

async function copyTextDialog() {
  const text = $('#textDialogBody').value;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const ta = $('#textDialogBody');
    ta.removeAttribute('readonly');
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败，请手动选中', true);
    }
    ta.setAttribute('readonly', '');
    ta.blur();
  }
}

/* ============================================================
 *  Token 权限检查
 * ============================================================ */
function tokenKind(token) {
  if (!token) return '未填写';
  if (token.startsWith('github_pat_')) return 'fine-grained token';
  if (token.startsWith('ghp_')) return 'classic token';
  if (token.startsWith('gho_')) return 'OAuth token';
  if (token.startsWith('ghu_')) return 'App 用户 token';
  if (token.startsWith('ghs_')) return 'App 服务器 token';
  return '未知格式';
}

/** 请求不带 /repos/{owner}/{repo} 前缀的接口（例如 /user） */
async function rawApi(path) {
  const s = state.settings;
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${s.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (e) {
    throw new ApiError('无法连接 api.github.com（网络或代理问题）', 0, e.message);
  }
  if (!res.ok) {
    let apiMessage = '';
    try {
      const j = await res.json();
      apiMessage = j.message || '';
    } catch { /* 非 JSON */ }
    const msg = res.status === 401 ? 'Token 无效或已过期' : (apiMessage || `HTTP ${res.status}`);
    throw new ApiError(msg, res.status, apiMessage);
  }
  return res;
}

function renderPermRows(rows) {
  const ul = $('#permList');
  ul.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'unknown';

    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = r.ok === true ? '✓' : r.ok === false ? '✗' : '?';

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = r.label;

    const det = document.createElement('span');
    det.className = 'det';
    det.textContent = r.detail;

    li.append(ico, lbl, det);
    ul.appendChild(li);
  }
  $('#permResult').hidden = rows.length === 0;
}

/**
 * 检查常用权限。浏览器读不到 X-OAuth-Scopes（GitHub 未在 CORS 中暴露），
 * 所以只能靠 /user 与仓库的 permissions 位，加上端点探测。
 */
async function checkTokenPermissions() {
  readSettingsForm();
  const s = state.settings;
  const rows = [];
  const add = (ok, label, detail) => rows.push({ ok, label, detail });

  const btn = $('#btnCheckPerm');
  btn.disabled = true;
  $('#connResult').textContent = '';
  $('#connResult').className = 'conn-result';
  $('#permResult').hidden = false;
  $('#permList').innerHTML = '<li class="unknown"><span class="ico">…</span><span class="det">检查中</span></li>';

  try {
    if (!s.token) {
      add(false, 'Token', '未填写');
      renderPermRows(rows);
      return;
    }

    // 1. Token 是否有效
    let rate = '';
    let res;
    try {
      res = await rawApi('/user');
      const u = await res.json();
      const limit = res.headers.get('x-ratelimit-limit');
      const remain = res.headers.get('x-ratelimit-remaining');
      if (limit) rate = `${remain}/${limit}`;
      add(true, 'Token 有效', `${u.login} · ${tokenKind(s.token)}`);
    } catch (e) {
      add(false, 'Token 无效', e.message);
      renderPermRows(rows);
      return;
    }

    // 2. 仓库是否可读，以及权限位
    let repo;
    try {
      repo = await gh('');
      add(true, '仓库读取', `${repo.full_name}（${repo.private ? '私有' : '公开'}）`);
    } catch (e) {
      add(false, '仓库读取', e.message);
      renderPermRows(rows);
      return;
    }

    const p = repo.permissions || {};
    add(!!p.push, '内容读写', p.push ? '可以提交文章和图片' : '只读，发布会被拒绝');
    if (p.admin) add(true, '仓库管理', 'admin 权限');
    else if (p.maintain) add(true, '仓库管理', 'maintain 权限');

    // 3. Actions 读取（决定能否看到构建状态）
    try {
      await gh('/actions/workflows');
      add(true, 'Actions 读取', '可以查看构建记录');
    } catch (e) {
      if (e.status === 404) add(null, 'Actions 读取', '仓库没启用 Actions 或还没有 workflow');
      else add(false, 'Actions 读取', e.message);
    }

    // 4. Workflows 写入：GitHub 没有查询接口
    add(null, 'Workflows 写', '没有查询接口，提交 workflow 文件时才会暴露');

    // 5. Pages 配置（部署失败的常见原因就在这里）
    try {
      const pages = await gh('/pages');
      const isWorkflow = pages.build_type === 'workflow';
      const kind = pages.build_type === 'workflow'
        ? 'GitHub Actions'
        : pages.build_type === 'legacy'
          ? '分支部署（需要改成 GitHub Actions）'
          : (pages.build_type || '未知');
      add(isWorkflow, 'Pages 来源', `${kind} · ${pages.status || ''}`.trim());
    } catch (e) {
      if (e.status === 404) add(null, 'Pages 来源', '尚未启用，去 Settings → Pages 选 GitHub Actions');
      else if (e.status === 403) add(null, 'Pages 来源', 'token 没有 pages 读权限，去网页上确认');
      else add(null, 'Pages 来源', e.message);
    }

    if (rate) add(true, 'API 配额', `剩余 ${rate}`);
  } finally {
    renderPermRows(rows);
    btn.disabled = false;
  }
}

/* ============================================================
 *  Hexo 站点初始化
 * ============================================================ */
const HEXO_FILES = [
  'package.json',
  '_config.yml',
  '.github/workflows/deploy.yml',
  'scripts/inject-katex.js',
  'scaffolds/post.md',
];

/** 从站点地址推导 url / root / 图片前缀 */
function deriveSite() {
  const s = state.settings;
  const fallback = `https://${s.owner.toLowerCase()}.github.io/${s.repo}`;
  try {
    const u = new URL(s.siteUrl || fallback);
    const path = u.pathname.replace(/\/+$/, '');
    return {
      url: u.origin,
      root: `${path}/`,
      imagePrefix: `${path}/images`,
    };
  } catch {
    return { url: fallback, root: `/${s.repo}/`, imagePrefix: `/${s.repo}/images` };
  }
}

function buildHexoFiles() {
  const s = state.settings;
  const site = deriveSite();
  const author = s.owner || 'author';

  const pkg = {
    name: 'hexo-site',
    version: '1.0.0',
    private: true,
    scripts: { build: 'hexo generate', clean: 'hexo clean', server: 'hexo server' },
    hexo: { version: '7.3.0' },
    dependencies: {
      '@traptitech/markdown-it-katex': '^3.6.0',
      hexo: '^7.3.0',
      'hexo-blog-encrypt': '^4.1.0',
      'markdown-it-task-lists': '^2.1.1',
      'hexo-generator-archive': '^2.0.0',
      'hexo-generator-category': '^2.0.0',
      'hexo-generator-index': '^3.0.0',
      'hexo-generator-tag': '^2.0.0',
      'hexo-renderer-ejs': '^2.0.0',
      'hexo-renderer-markdown-it': '^7.0.0',
      'hexo-renderer-stylus': '^3.0.0',
      'hexo-server': '^3.0.0',
      'hexo-theme-landscape': '^1.0.0',
      katex: '^0.16.11',
    },
  };

  const config = `title: ${author} 的博客
subtitle: ''
description: ''
keywords:
author: ${author}
language: zh-CN
timezone: 'Asia/Shanghai'

url: ${site.url}
root: ${site.root}
permalink: :year/:month/:day/:title/

source_dir: source
public_dir: public
tag_dir: tags
archive_dir: archives
category_dir: categories
code_dir: downloads/code
i18n_dir: :lang
skip_render:

new_post_name: :title.md
default_layout: post
titlecase: false
external_link:
  enable: true
  field: site
  exclude:
filename_case: 0
render_drafts: false
post_asset_folder: false
relative_link: false

# 定时发布依赖这一项：false 时日期在未来的文章不会被渲染
future: false

highlight:
  enable: true
  line_number: true
  auto_detect: false
  tab_replace: ''
  wrap: true
  hljs: false

index_generator:
  path: ''
  per_page: 20
  order_by: -date

# 归档 / 分类 / 标签页的分页（主题已渲染翻页控件）
archive_generator:
  per_page: 30
  yearly: true
  monthly: false
  daily: false

category_generator:
  per_page: 30

tag_generator:
  per_page: 30

# 文章加密（hexo-blog-encrypt）
# 在文章的 front-matter 里写 password: xxx 即可，构建时正文会被加密，
# 访客输入密码后由浏览器解密。注意：这是真加密，公开的只有密文。
encrypt:
  abstract: 这是一篇加密文章，请输入访问密码
  message: 请输入访问密码
  wrong_pass_message: 密码不正确，请重试
  theme: default
  # 记住密码：密钥存 localStorage，同一篇再访问不用重复输入
  autoSave: true
  # salt 跟 permalink 绑定。默认 false 时每次构建 salt 都会变，
  # GitHub Actions 每次都干净重建，缓存会因此失效、被迫重新输密码。
  stableSalt: true
  kdf:
    iterations: 600000

# 评论（giscus）：数据存在本仓库的 GitHub Discussions，不需要服务器。
# 在后台「设置 → 评论」里填仓库和分类 ID（ID 去 https://giscus.app 生成），
# 或直接改这里的值。enable 打开、ID 填齐后文章页才会渲染评论区。
comments:
  enable: false
  giscus:
    repo: '${author}/${s.repo}'
    repoId: ''
    category: ''
    categoryId: ''
    mapping: pathname
    strict: 0
    reactionsEnabled: 1
    emitMetadata: 0
    inputPosition: top
    lang: zh-CN
    theme: auto
    loading: lazy

# 浏览量（GoatCounter）：免费、无 Cookie，需要在 goatcounter.com 建站点。
views:
  enable: false
  code: ''
  label: 阅读

default_category: uncategorized
category_map:
tag_map:

meta_generator: true
date_format: YYYY-MM-DD
time_format: HH:mm:ss
updated_option: 'mtime'

per_page: 10
pagination_dir: page

theme: landscape

markdown:
  render:
    html: true
    xhtmlOut: false
    breaks: false
    linkify: true
    typographer: false
  plugins:
    - "@traptitech/markdown-it-katex"
    - "markdown-it-task-lists"
`;

  const deploy = `name: Deploy Hexo

on:
  push:
    branches: [${s.branch}]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install
        run: npm install
      - name: Build
        run: npx hexo generate
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./public

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;

  const inject = `'use strict';

/**
 * 1) 给真正包含公式的页面注入 KaTeX 样式。
 * 2) 关掉 Nunjucks 对文章内容的解析。
 *
 * 第 2 点很关键：Hexo 的 Swig 标签转义只处理「完整」的 {{ }} / {% %} / {# #}，
 * 像 LaTeX 颜色写法 \\color {#C0C0C0} 里的 {# 没有配对的 #}，
 * 会被 Nunjucks 当成未闭合注释，构建直接报 expected end of comment。
 * 这个博客不使用 Hexo 的 {% %} 标签语法，关掉没有副作用。
 */
const KATEX_CSS = '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css">';

hexo.extend.filter.register('after_init', function () {
  const renderer = hexo.render.renderer.get('md');
  if (renderer) renderer.disableNunjucks = true;
});

// 引用块里的 ">文字"（> 后没有空格）在 fenced code 内会让 markdown-it 把 ">" 留在代码里。
// 渲染前补空格，渲染后再对代码块兜底清理一次。
hexo.extend.filter.register('before_post_render', function (data) {
  // 引用块里 ">文字" 缺空格时，fenced code 内会把 > 留在代码里
  data.content = data.content.replace(/^>(\\S)/gm, '> $1');

  // 行内公式两端有空白时 markdown-it-katex 会直接跳过（$ x $ 原样输出），
  // 这里去掉首尾空白，$$ 块不受影响。
  data.content = data.content.replace(
    /\\$(?!\\$)([ \\t]*)([^$\\n]+?)([ \\t]*)\\$(?!\\$)/g,
    function (m, a, inner) {
      if (!inner.trim()) return m;
      return '$' + inner.trim() + '$';
    }
  );

  // 任务列表项里的 ATX 标题（- [ ] ##### xxx）改成 HTML 标题。
  // markdown-it 不支持列表项内写标题（##### 不在行首），Typora 支持；这里等价实现。
  data.content = data.content.replace(
    /^([ \\t]*(?:[-*+]|\\d+[.)])[ \\t]+)\\[([ xX])\\][ \\t]+(#{1,6})[ \\t]+(.+)$/gm,
    function (m, prefix, mark, hashes, content) {
      var level = hashes.length;
      var checked = mark.toLowerCase() === 'x' ? ' checked' : '';
      var inner = content.replace(/\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
      return prefix + '<input type="checkbox" class="task-list-item-checkbox" disabled'
        + checked + '> <h' + level + '>' + inner + '</h' + level + '>';
    }
  );

  return data;
});

// KaTeX 会把公式输出两份（MathML + 视觉 HTML），直接抽文本会让标题重复一遍，
// 这里把标题内的 MathML 副本去掉，同时清理正文里的 [toc] 占位。
hexo.extend.filter.register('after_post_render', function (data) {
  data.content = data.content.replace(/<h([1-6])([^>]*)>([\\s\\S]*?)<\\/h\\1>/g, function (m, lvl, attrs, inner) {
    var cleaned = inner.replace(/<span class="katex-mathml"><math[\\s\\S]*?<\\/math><\\/span>/g, '');
    return '<h' + lvl + attrs + '>' + cleaned + '</h' + lvl + '>';
  });
  data.content = data.content.replace(/<p>\\[toc\\]<\\/p>/gi, '');
  // 未闭合的 <font size=4> 会把后面所有 DOM（含侧边栏）包进去，导致 sticky 失效。
  // 只删带 size 的开标签，color 的保留。
  data.content = data.content.replace(/<font\\s+size\\s*=\\s*["']?\\d+["']?\\s*>/gi, '');
  // 博客园图床有防盗链，带本站 Referer 会 403，图片标签统一不发送 Referer
  data.content = data.content.replace(/<img /g, '<img referrerpolicy="no-referrer" ');
  // 兜底：去掉代码块每行开头被误留下的 ">"
  data.content = data.content.replace(/(<figure class="highlight[^"]*">[\\s\\S]*?<\\/figure>)/g, function (block) {
    return block.replace(/<span class="line">&gt;/g, '<span class="line">');
  });
  return data;
});

hexo.extend.filter.register('after_render:html', function (str) {
  // 加密文章的公式在密文里，HTML 里查不到 class="katex"，但解密后会显示出来，
  // 所以页面上出现了加密容器时也要注入样式，否则 MathML 会裸露、公式重复一遍。
  if (!str.includes('class="katex"') && !str.includes('id="hexo-blog-encrypt"')) return str;
  if (str.includes('katex.min.css')) return str;
  if (!str.includes('</head>')) return str;
  return str.replace('</head>', \`  \${KATEX_CSS}\\n</head>\`);
});
`;

  const scaffold = `---
title: {{ title }}
date: {{ date }}
tags:
---
`;

  const now = new Date();
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  const da = pad2(now.getDate());

  const hello = `---
title: 你好，世界
date: ${fmtDateLocal(now)}
permalink: ${y}/${mo}/${da}/开始/hello-world/
categories:
  - 开始
tags:
  - 开始
---

这是由后台生成的示例文章，可以随时删除。

## 公式

行内公式 $E = mc^2$，块级公式：

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

## 图片

上传的图片会存到 \`source/images/年/月/\`，文章里用 \`${site.imagePrefix}\` 开头引用。
`;

  return [
    { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: '_config.yml', content: config },
    { path: '.github/workflows/deploy.yml', content: deploy },
    { path: 'scripts/inject-katex.js', content: inject },
    { path: 'scaffolds/post.md', content: scaffold },
    // 示例文章只在不存在时创建，避免重复初始化覆盖用户改动
    { path: 'source/_posts/开始/hello-world.md', content: hello, createOnly: true },
    { path: '.gitignore', content: 'node_modules/\npublic/\n.deploy*/\ndb.json\n' },
  ];
}

/**
 * 用 Git Data API 一次提交多个文件（增删改混合）。
 * changes: [{ path, content }] 写入 / [{ path, sha: null }] 删除
 */
async function commitFiles(changes, message, watchTitle, attempts = 1) {
  const branch = state.settings.branch;

  let headSha;
  try {
    const ref = await gh(`/git/ref/heads/${branch}`);
    headSha = ref.object.sha;
  } catch (e) {
    const emptyRepo = e.status === 404
      || (e.status === 409 && /empty/i.test(e.apiMessage || e.message || ''));
    if (!emptyRepo) throw e;

    // 空仓库（一个提交都没有）：先用 Contents API 打一个初始提交，
    // GitHub 会顺带把分支建出来，之后就能正常走 Git Data API。
    await gh('/contents/README.md', {
      method: 'PUT',
      body: {
        message: 'init: 建立初始提交',
        content: b64encodeUtf8(`# ${state.settings.repo}\n\n本仓库由博客后台初始化。\n`),
        branch,
      },
    });

    // 分支刚建出来时 ref 接口可能还没跟上，轮询几次再读
    let ref2 = null;
    for (let i = 0; i < 6; i++) {
      try {
        ref2 = await gh(`/git/ref/heads/${branch}`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (!ref2) {
      throw new ApiError('初始提交已建立，但分支还没就绪，请稍等几秒后重试', 0);
    }
    headSha = ref2.object.sha;
  }

  const headCommit = await gh(`/git/commits/${headSha}`);
  const baseTree = headCommit.tree.sha;

  const tree = [];
  for (const c of changes) {
    if (c.sha === null) {
      tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
    } else if (c.base64) {
      // 二进制文件：先建 blob 再引用，tree 的 content 字段只收文本
      const blob = await gh('/git/blobs', {
        method: 'POST',
        body: { content: c.base64, encoding: 'base64' },
      });
      tree.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha });
    } else {
      tree.push({ path: c.path, mode: '100644', type: 'blob', content: c.content });
    }
  }

  const newTree = await gh('/git/trees', {
    method: 'POST',
    body: { base_tree: baseTree, tree },
  });

  const newCommit = await gh('/git/commits', {
    method: 'POST',
    body: { message, tree: newTree.sha, parents: [headSha] },
  });

  try {
    await gh(`/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: { sha: newCommit.sha },
    });
  } catch (e) {
    // 分支在这期间被别人（或另一标签页）推过，重读一次 HEAD 再试
    if ((e.status === 409 || e.status === 422) && attempts < 2) {
      return commitFiles(changes, message, watchTitle, attempts + 1);
    }
    throw e;
  }

  // 每次提交后自动盯一下这次构建
  startActionWatch(newCommit.sha, watchTitle);

  return newCommit.sha;
}

/* ============================================================
 *  构建状态（GitHub Actions）
 *
 *  这是「最近一次真实 GET 到的状态」，不是推测值：
 *  没查成功就不刷新时间戳，也不会拿旧 run 的结论冒充本次提交。
 * ============================================================ */
/** GitHub Actions 里「还没结束」的状态（pending / requested 也会出现） */
const RUN_ACTIVE_STATUSES = ['queued', 'waiting', 'pending', 'requested', 'action_required', 'in_progress'];

/** 状态 → 中文 */
const RUN_STATUS_LABEL = {
  queued: '排队中',
  waiting: '等待中',
  pending: '等待中',
  requested: '已请求',
  action_required: '待确认',
  in_progress: '构建中',
};

const actionWatch = {
  active: false,
  sha: null,          // 本次提交，用于认领对应的 run
  title: '',          // 文章标题之类的可读描述
  startedAt: 0,
  fetchedAt: 0,       // 最近一次成功 GET 的时间
  lastChangeAt: 0,    // 最近一次状态发生变化的时间
  lastKey: '',
  hasRunning: false,
  runs: [],           // 最近一次拿到的 run 列表
  waitForSha: false,  // 本次提交的 run 还没出现
  timer: null,
  clockTimer: null,
};

function stopActionWatch() {
  if (actionWatch.timer) { clearTimeout(actionWatch.timer); actionWatch.timer = null; }
  if (actionWatch.clockTimer) { clearInterval(actionWatch.clockTimer); actionWatch.clockTimer = null; }
  actionWatch.active = false;
}

function relTime(ms) {
  if (!ms) return '';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 3) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  return `${Math.round(min / 60)} 小时前`;
}

/** 把一次 run 翻译成「在做什么」 */
function describeRun(run) {
  if (!run) return '';

  if (run.event === 'schedule') return '定时构建';
  if (run.event === 'workflow_dispatch') return '手动构建';
  if (run.event === 'workflow_run') return '串联构建';

  const msg = ((run.display_title || (run.head_commit && run.head_commit.message)) || '')
    .split('\n')[0].trim();

  const rules = [
    [/^feat:\s*安装博客园风格主题/, '安装主题'],
    [/^chore:\s*迁移外链/, '迁移外链'],
    [/^chore:\s*整理文章目录/, '整理目录'],
    [/^config:\s*更新首页格言/, '更新格言'],
    [/^config:/, '站点配置'],
    [/^post:\s*(.+)$/, (m) => `发布「${m[1].trim()}」`],
    [/^feat:/, '功能更新'],
    [/^fix:/, '修 bug'],
    [/^docs:/, '改文档'],
    [/^chore:/, '维护'],
  ];
  for (const [re, label] of rules) {
    const m = re.exec(msg);
    if (m) return typeof label === 'function' ? label(m) : label;
  }

  if (msg) return msg.length > 18 ? `${msg.slice(0, 18)}…` : msg;
  return run.name || '构建';
}

/** 渲染顶栏徽章；数据全部来自最近一次成功 GET */
function renderActionBadge() {
  const el = $('#actionBadge');
  if (!el) return;

  const { runs, waitForSha, fetchedAt, title } = actionWatch;
  const running = (runs || []).filter((r) => RUN_ACTIVE_STATUSES.includes(r.status));

  if (!runs.length && !waitForSha) { el.hidden = true; return; }

  let cls = 'running';
  let main = '';
  let detail = '';

  if (running.length) {
    if (running.length === 1) {
      const r = running[0];
      main = RUN_STATUS_LABEL[r.status] || '构建中';
      detail = describeRun(r);
    } else {
      main = `构建中 ×${running.length}`;
      const names = running.map((r) => describeRun(r));
      detail = [...new Set(names)].join(' / ');
    }
  } else if (waitForSha) {
    main = '等待构建';
    detail = title ? `发布「${title}」` : '本次提交';
  } else {
    const latest = runs[0];
    if (!latest) { el.hidden = true; return; }
    if (latest.status === 'completed') {
      if (latest.conclusion === 'success') { cls = 'success'; main = '构建成功'; }
      else if (latest.conclusion === 'failure') { cls = 'failure'; main = '构建失败'; }
      else if (latest.conclusion === 'cancelled') { cls = 'running'; main = '已取消'; }
      else { cls = 'running'; main = latest.conclusion || '已结束'; }
    } else {
      main = '构建中';
    }
    detail = describeRun(latest);
  }

  const time = relTime(fetchedAt);

  el.className = `action-badge ${cls}`;
  el.innerHTML = '<span class="badge-dot"></span>'
    + `<span class="badge-main">${main}</span>`
    + (detail ? `<span class="badge-sep">·</span><span class="badge-detail">${detail}</span>` : '')
    + (time ? `<span class="badge-time">${time}</span>` : '');

  const target = running[0] || runs[0];
  el.href = (target && target.html_url) || '#';

  const lines = [`${main}${detail ? ` · ${detail}` : ''}`];
  if (fetchedAt) lines.push(`最后确认：${relTime(fetchedAt)}（北京时间 ${new Date(fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}）`);
  if (running.length) {
    lines.push(`正在运行 ${running.length} 个：`);
    running.forEach((r) => {
      lines.push(`  · ${r.name || 'Actions'} — ${describeRun(r)}（${RUN_STATUS_LABEL[r.status] || r.status}）`);
    });
  }
  if (waitForSha) lines.push('本次提交的构建任务还没出现在 GitHub 上');
  lines.push('点击查看日志');
  el.title = lines.join('\n');
  el.hidden = false;
}

async function fetchRecentRuns(limit = 5) {
  if (!settingsReady()) return null;
  const branch = encodeURIComponent(state.settings.branch);
  // 不限 workflow：部署、定时、自己加的都会返回
  const data = await gh(`/actions/runs?per_page=${limit}&branch=${branch}`);
  return data.workflow_runs || [];
}

/** 查一次并刷新徽章。返回是否还有进行中的构建 */
/** Action 成功后同步仓库结构，保持本地视图和线上一致 */
async function postDeployRefresh() {
  try {
    await loadPosts();
    setStatus('构建完成，列表已同步');
  } catch (e) {
    console.warn('构建完成后同步失败', e);
  }
}

async function pollActionsOnce() {
  const branch = encodeURIComponent(state.settings.branch);
  void branch;

  const runs = await fetchRecentRuns(5);
  if (runs === null) return false;

  // 只有真正拿到数据才更新时间戳
  actionWatch.fetchedAt = Date.now();
  actionWatch.runs = runs;

  const mine = actionWatch.sha ? runs.filter((r) => r.head_sha === actionWatch.sha) : [];
  const running = runs.filter((r) => RUN_ACTIVE_STATUSES.includes(r.status));

  actionWatch.waitForSha = !!actionWatch.sha && mine.length === 0 && running.length === 0;
  actionWatch.hasRunning = running.length > 0;

  const key = JSON.stringify({
    running: running.map((r) => `${r.id}:${r.status}`),
    mine: mine.map((r) => `${r.id}:${r.status}:${r.conclusion}`),
    wait: actionWatch.waitForSha,
  });
  if (key !== actionWatch.lastKey) {
    actionWatch.lastKey = key;
    actionWatch.lastChangeAt = Date.now();
  }

  // 本次提交对应的构建成功后，同步一次仓库结构（新建/移动的文件此时才真正稳定）
  if (actionWatch.sha) {
    const done = mine.find((r) => r.status === 'completed' && r.conclusion === 'success');
    if (done && actionWatch.notifiedSha !== actionWatch.sha) {
      actionWatch.notifiedSha = actionWatch.sha;
      setTimeout(() => { postDeployRefresh(); }, 1200);
    }
  }

  renderActionBadge();
  return actionWatch.hasRunning || actionWatch.waitForSha;
}

/** 打开页面时刷新一次（不启动轮询） */
async function refreshActionStatus() {
  try {
    await pollActionsOnce();
    actionWatch.sha = null;
  } catch {
    const el = $('#actionBadge');
    if (el) el.hidden = true;
  }
}

/**
 * 盯构建：按状态自适应轮询。
 * - 提交后 30 秒内高频（1.5s），因为 run 可能还没创建
 * - 有进行中的构建 2s
 * - 状态刚变化后 15 秒内 2s
 * - 全部结束且没有新动静 → 30s 低频，静默等待下一次
 */
function startActionWatch(sha, title) {
  stopActionWatch();

  actionWatch.active = true;
  actionWatch.sha = sha || null;
  actionWatch.title = title || '';
  actionWatch.startedAt = Date.now();
  actionWatch.lastChangeAt = Date.now();
  actionWatch.lastKey = '';
  actionWatch.waitForSha = !!sha;
  actionWatch.hasRunning = false;

  const badge = $('#actionBadge');
  if (badge) {
    badge.className = 'action-badge running';
    badge.innerHTML = '<span class="badge-dot"></span><span class="badge-main">已提交</span>'
      + (title ? `<span class="badge-sep">·</span><span class="badge-detail">发布「${title}」</span>` : '')
      + '<span class="badge-time">等待构建</span>';
    badge.title = '提交成功，正在等待 GitHub 创建构建任务';
    badge.hidden = false;
  }

  // 每秒刷新「x 秒前」，不额外发请求
  actionWatch.clockTimer = setInterval(renderActionBadge, 1000);

  const tick = async () => {
    let stillWorking = false;
    try {
      stillWorking = await pollActionsOnce();
    } catch { /* 单次失败按未变化处理 */ }

    if (!actionWatch.active) return;

    const now = Date.now();
    const sinceStart = now - actionWatch.startedAt;
    const sinceChange = now - actionWatch.lastChangeAt;

    let delay;
    if (stillWorking) {
      delay = 2000;
    } else if (sinceStart < 30000) {
      delay = 1500;          // 刚提交，run 可能还没出现
    } else if (sinceChange < 15000) {
      delay = 2000;          // 状态刚变过，再确认一会儿
    } else {
      delay = 30000;         // 稳定了，低频盯着新动静
    }

    actionWatch.timer = setTimeout(tick, delay);
  };

  tick();
}

async function initHexoSite() {
  if (!settingsReady()) { toast('请先填写仓库信息和 Token', true); return; }

  const el = $('#siteResult');
  const btn = $('#btnInitHexo');

  let exists = false;
  try {
    await getFile('_config.yml');
    exists = true;
  } catch { /* 不存在 */ }

  if (exists && !confirm('仓库里已经有 _config.yml。继续会覆盖 package.json、_config.yml、部署 workflow 等文件（不会动文章和图片），确定吗？')) {
    return;
  }

  btn.disabled = true;
  el.className = 'conn-result';
  el.textContent = '正在提交…';

  try {
    const files = buildHexoFiles();
    const toWrite = [];
    const existing = [];
    for (const f of files) {
      let cur = null;
      try {
        cur = await getFile(f.path);
      } catch { /* 新文件 */ }
      if (cur && f.createOnly) continue; // 示例文章等只创建不覆盖
      if (cur && cur.text !== f.content) existing.push(f.path);
      toWrite.push(f);
    }

    let skippedWorkflow = false;
    try {
      await commitFiles(toWrite.map((f) => ({ path: f.path, content: f.content })), 'chore: 初始化 Hexo 站点');
    } catch (e) {
      // 只有 403 才是真的 workflow 权限问题（没有 Workflows 权限时不能在 .github/workflows 下写文件）。
      // 404 / 409 交给 commitFiles 内部处理，不能在这里重试，否则会掩盖真正的错误。
      if (e.status !== 403) throw e;
      const withoutWf = toWrite.filter((f) => !f.path.startsWith('.github/workflows/'));
      await commitFiles(
        withoutWf.map((f) => ({ path: f.path, content: f.content })),
        'chore: 初始化 Hexo 站点（跳过 workflow）',
      );
      skippedWorkflow = true;
    }

    // 顺手把图片前缀校正为子路径版本
    const site = deriveSite();
    if (state.settings.imagePrefix !== site.imagePrefix) {
      state.settings.imagePrefix = site.imagePrefix;
      localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
      fillSettingsForm();
    }

    if (skippedWorkflow) {
      const deploy = files.find((f) => f.path === '.github/workflows/deploy.yml');
      el.className = 'conn-result';
      el.textContent = '站点文件已提交，但 workflow 被权限拒绝（见弹窗，可手动创建）';
      showTextDialog({
        title: '部署 workflow 需要手动创建',
        hint: '当前 token 没有 Workflows 权限，站点骨架已经提交成功，只差这一个部署文件。'
          + '点「在 GitHub 打开」新建，把下面的内容粘进去保存即可；'
          + '或者给 token 加上 Workflows: Read and write 后重新点一次初始化。',
        text: deploy.content,
        link: `https://github.com/${state.settings.owner}/${state.settings.repo}/new/${state.settings.branch}`
          + `?filename=${encodeURIComponent('.github/workflows/deploy.yml')}`,
      });
    } else {
      el.className = 'conn-result ok';
      el.textContent = `已提交 ${toWrite.length} 个文件，站点根路径 ${site.root}`
        + (existing.length ? `（覆盖了 ${existing.length} 个已存在文件）` : '');
      toast('Hexo 站点已初始化');
    }

    await new Promise((r) => setTimeout(r, 1200));
    await loadPosts();
  } catch (e) {
    el.className = 'conn-result bad';
    const hint = (e.status === 403 || e.status === 404)
      ? '若只是 workflow 文件被拒，token 需要 Workflows: Read and write 权限'
      : '';
    el.textContent = `失败：${e.message}${hint ? '（' + hint + '）' : ''}`;
  } finally {
    btn.disabled = false;
  }
}

async function removeHexoSkeleton() {
  if (!settingsReady()) { toast('请先填写仓库信息和 Token', true); return; }
  if (!confirm(
    '将删除以下文件（文章和图片不受影响）：\n\n'
    + HEXO_FILES.join('\n')
    + '\n.github/workflows/scheduled-rebuild.yml\n\n确定吗？'
  )) return;

  const el = $('#siteResult');
  const btn = $('#btnRemoveHexo');
  btn.disabled = true;
  el.className = 'conn-result';
  el.textContent = '正在删除…';

  try {
    const targets = [...HEXO_FILES, '.github/workflows/scheduled-rebuild.yml'];
    const present = [];
    for (const path of targets) {
      try {
        await getFile(path);
        present.push(path);
      } catch { /* 不存在就跳过 */ }
    }
    if (!present.length) {
      el.className = 'conn-result';
      el.textContent = '没有找到可删除的文件';
      return;
    }

    await commitFiles(present.map((path) => ({ path, sha: null })), 'chore: 移除 Hexo 骨架');
    el.className = 'conn-result ok';
    el.textContent = `已删除 ${present.length} 个文件，source/_posts 和 source/images 保留`;
    toast('已移除 Hexo 骨架');
  } catch (e) {
    el.className = 'conn-result bad';
    el.textContent = `失败：${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
 *  博客园风格主题：一键安装
 * ============================================================ */
/** 按来源切换设置面板里显示哪些行 */
function toggleMottoRows() {
  const src = $('#fMottoSource').value;
  $('#mottoApiRow').hidden = src !== 'api';
  $('#mottoTxtRow').hidden = src !== 'txt';
}

/** 读取主题配置里的格言设置，填进设置面板 */
async function loadMottoSettings() {
  if (!settingsReady()) return;
  try {
    const { text } = await getFile('themes/cnblog/_config.yml');
    const source = ((/^mottoSource:\s*(\S+)/m.exec(text) || [])[1] || 'builtin').trim();
    const api = ((/^mottoApi:\s*(.+)$/m.exec(text) || [])[1] || '').trim();
    const motto = ((/^motto:\s*(.+)$/m.exec(text) || [])[1] || '').trim();
    const from = ((/^motto_from:\s*(.+)$/m.exec(text) || [])[1] || '').trim();

    $('#fMottoSource').value = ['builtin', 'api', 'txt'].includes(source) ? source : 'builtin';
    $('#fMottoApi').value = api;
    $('#fMottoText').value = motto;
    $('#fMottoFrom').value = from;
    toggleMottoRows();
  } catch { /* 主题还没装，忽略 */ }
}

/** 把格言设置写回主题 _config.yml */
async function saveMottoSettings() {
  if (!settingsReady()) { toast('请先配置仓库', true); return; }

  const btn = $('#btnSaveMotto');
  const result = $('#mottoResult');
  btn.disabled = true;

  try {
    const path = 'themes/cnblog/_config.yml';
    const { text, sha } = await getFile(path);

    const source = $('#fMottoSource').value;
    const api = $('#fMottoApi').value.trim() || 'https://v1.hitokoto.cn/?c=i&encode=json';
    const motto = $('#fMottoText').value.trim() || '星垂平野阔，月涌大江流。';
    const from = $('#fMottoFrom').value.trim();

    let next = text;
    if (/^mottoSource:/m.test(next)) next = next.replace(/^mottoSource:.*$/m, `mottoSource: ${source}`);
    else next = next.replace(/^motto:/m, `mottoSource: ${source}\nmotto:`);

    if (/^mottoApi:/m.test(next)) next = next.replace(/^mottoApi:.*$/m, `mottoApi: ${api}`);
    else next = next.replace(/^mottoTxt:/m, `mottoApi: ${api}\nmottoTxt:`);

    next = next.replace(/^motto:.*$/m, `motto: ${motto}`);
    next = next.replace(/^motto_from:.*$/m, `motto_from: ${from}`);

    if (next === text) {
      result.textContent = '设置没有变化';
      result.className = 'conn-result';
      return;
    }

    await putFile(path, next, 'config: 更新首页格言', sha);

    const label = { builtin: '内置诗句库', api: '一言 API', txt: 'motto.txt' }[source];
    result.textContent = `已保存（${label}），构建完成后生效`;
    result.className = 'conn-result ok';
    toast('格言设置已提交');
  } catch (e) {
    result.textContent = `保存失败：${e.message}`;
    result.className = 'conn-result bad';
    toast(`保存失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/** 上传本地 txt 到仓库的 source/motto.txt */
async function uploadMottoFile(file) {
  const result = $('#mottoResult');
  try {
    const raw = await file.text();
    const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { toast('文件是空的', true); return; }

    let sha;
    try { sha = (await getFile('source/motto.txt')).sha; } catch { /* 新建 */ }

    await putFile('source/motto.txt', lines.join('\n') + '\n', 'motto: 更新诗句文件', sha);

    result.textContent = `已上传 ${lines.length} 句到 source/motto.txt`;
    result.className = 'conn-result ok';
    toast(`已上传 ${lines.length} 句诗句`);
  } catch (e) {
    result.textContent = `上传失败：${e.message}`;
    result.className = 'conn-result bad';
    toast(`上传失败：${e.message}`, true);
  }
}

/** 下载仓库里的 source/motto.txt */
async function downloadMottoFile() {
  const result = $('#mottoResult');
  try {
    const { text } = await getFile('source/motto.txt');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'motto.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    result.textContent = `已下载（${text.split(/\r?\n/).filter(Boolean).length} 行）`;
    result.className = 'conn-result ok';
  } catch (e) {
    result.textContent = `下载失败：${e.message}（仓库里可能还没有 motto.txt）`;
    result.className = 'conn-result bad';
  }
}
/* ============================================================
 *  评论（giscus）
 *  配置写在站点根目录 _config.yml 的 comments 段：
 *  主题安装会整份覆盖 themes/cnblog/_config.yml，放主题里 repoId 会被冲掉。
 * ============================================================ */
const COMMENT_DEFAULTS = {
  enable: false,
  repo: '',
  repoId: '',
  category: '',
  categoryId: '',
  mapping: 'pathname',
  strict: 0,
  reactionsEnabled: 1,
  emitMetadata: 0,
  inputPosition: 'top',
  lang: 'zh-CN',
  theme: 'auto',
  loading: 'lazy',
};

/** 找 _config.yml 里顶层键 key 的起止行号（块尾的空行不算在块里） */
function findTopLevelBlock(lines, key) {
  const keyLine = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (keyLine < 0) return null;

  // 生成的段前面自带几行 "# ..." 说明。不把它们算进范围的话，
  // 每次保存都会在 comments: 上方再插一份说明，越存越长。
  let start = keyLine;
  while (start > 0 && lines[start - 1].startsWith('#')) start -= 1;

  let end = keyLine + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '' || /^\s/.test(line)) { end += 1; continue; }
    break; // 遇到下一个顶层键
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return { start, end };
}

/** 去掉 YAML 标量的引号和行尾注释 */
function unquoteYaml(raw) {
  let v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  if (!/^(['"]).*\1$/.test(v)) v = v.replace(/\s+#.*$/, '');
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return v;
}

/** 从站点 _config.yml 读评论配置（没有 comments 段就用默认值） */
function readCommentSettings(text) {
  const cfg = { ...COMMENT_DEFAULTS };
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const range = findTopLevelBlock(lines, 'comments');
  if (!range) return cfg;

  const block = lines.slice(range.start, range.end);
  const pick = (key) => {
    const re = new RegExp(`^\\s+${key}:\\s*(.*)$`);
    for (const line of block) {
      const m = re.exec(line);
      if (m) return unquoteYaml(m[1]);
    }
    return '';
  };
  const isOn = (v) => v === 'true' || v === '1';

  cfg.enable = isOn(pick('enable'));
  for (const key of ['repo', 'repoId', 'category', 'categoryId', 'mapping',
    'inputPosition', 'lang', 'theme', 'loading']) {
    const v = pick(key);
    if (v) cfg[key] = v;
  }
  cfg.strict = isOn(pick('strict')) ? 1 : 0;
  cfg.reactionsEnabled = isOn(pick('reactionsEnabled')) ? 1 : 0;
  cfg.emitMetadata = isOn(pick('emitMetadata')) ? 1 : 0;
  return cfg;
}

/** 生成 comments 段（固定写法，方便下次按行解析） */
function buildCommentBlock(c) {
  const q = (v) => `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;
  const num = (v) => (v ? '1' : '0');
  return [
    '# ==================== 评论（giscus） ====================',
    '# 评论存在本仓库的 GitHub Discussions 里，不需要任何服务器，也不会有广告和追踪。',
    '# enable 打开、且 repo / repoId / categoryId 都填了，文章页才会渲染评论区。',
    '# 这几个 ID 在 https://giscus.app 选好仓库和分类后自动生成。',
    'comments:',
    `  enable: ${c.enable ? 'true' : 'false'}`,
    '  giscus:',
    `    repo: ${q(c.repo)}`,
    `    repoId: ${q(c.repoId)}`,
    `    category: ${q(c.category)}`,
    `    categoryId: ${q(c.categoryId)}`,
    `    mapping: ${q(c.mapping)}`,
    `    strict: ${num(c.strict)}`,
    `    reactionsEnabled: ${num(c.reactionsEnabled)}`,
    `    emitMetadata: ${num(c.emitMetadata)}`,
    `    inputPosition: ${q(c.inputPosition)}`,
    `    lang: ${q(c.lang)}`,
    `    theme: ${q(c.theme)}`,
    `    loading: ${q(c.loading)}`,
  ].join('\n');
}

/** 替换（或追加）站点 _config.yml 的某个顶层段，其余内容原样保留 */
function writeTopLevelBlock(text, key, block) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blockLines = block.split('\n');
  const range = findTopLevelBlock(lines, key);

  if (range) {
    lines.splice(range.start, range.end - range.start, ...blockLines);
  } else {
    // 追加前先去掉文件末尾的空行，避免和下面的分隔空行叠成两行
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', ...blockLines);
  }

  // 统一成「以单个换行结尾」：否则下次保存会多出一行空行，
  // 内容明明没改却被判成有改动，白白多一次提交。
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/** 把仓库里的评论配置填进设置面板 */
async function loadCommentSettings() {
  if (!settingsReady()) return;
  try {
    const { text } = await getFile('_config.yml');
    const cfg = readCommentSettings(text);
    if (!cfg.repo && state.settings.owner && state.settings.repo) {
      cfg.repo = `${state.settings.owner}/${state.settings.repo}`;
    }

    $('#fCommentEnable').checked = cfg.enable;
    $('#fCommentRepo').value = cfg.repo;
    $('#fCommentRepoId').value = cfg.repoId;
    $('#fCommentCategory').value = cfg.category;
    $('#fCommentCategoryId').value = cfg.categoryId;
    $('#fCommentMapping').value = cfg.mapping;
    $('#fCommentInputPosition').value = cfg.inputPosition;
    $('#fCommentLang').value = cfg.lang;

    // 手改过的值（比如 gruvbox / pt）不在下拉选项里，补一个再选中
    const setSelect = (sel, value) => {
      if (![...sel.options].some((o) => o.value === value)) sel.add(new Option(value, value));
      sel.value = value;
    };
    setSelect($('#fCommentTheme'), cfg.theme);
    setSelect($('#fCommentLang'), cfg.lang);
    $('#fCommentReactions').checked = !!cfg.reactionsEnabled;
  } catch { /* 站点还没初始化，忽略 */ }
}

/** 校验并写回站点 _config.yml */
async function saveCommentSettings() {
  if (!settingsReady()) { toast('请先配置仓库', true); return; }

  const btn = $('#btnSaveComments');
  const result = $('#commentResult');
  btn.disabled = true;

  try {
    const enable = $('#fCommentEnable').checked;
    const repo = $('#fCommentRepo').value.trim();
    const repoId = $('#fCommentRepoId').value.trim();
    const category = $('#fCommentCategory').value.trim();
    const categoryId = $('#fCommentCategoryId').value.trim();

    if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      throw new Error('仓库要写成 owner/repo');
    }
    if (enable && (!repo || !repoId || !categoryId)) {
      throw new Error('启用评论前，仓库、repoId、categoryId 都要填');
    }

    const path = '_config.yml';
    const fixed = {
      enable, repo, repoId, category, categoryId,
      mapping: $('#fCommentMapping').value,
      inputPosition: $('#fCommentInputPosition').value,
      lang: $('#fCommentLang').value.trim() || 'zh-CN',
      theme: $('#fCommentTheme').value,
      reactionsEnabled: $('#fCommentReactions').checked ? 1 : 0,
    };

    // 409 = 手里的 sha 过期了：别的提交刚改过这个文件，或者读文件时命中了
    // GitHub API 的 60 秒响应缓存。重新读一遍再写，最多试 3 次。
    let saved = false;
    for (let attempt = 1; attempt <= 3 && !saved; attempt += 1) {
      const { text, sha } = await getFile(path);
      const prev = readCommentSettings(text);
      const next = writeTopLevelBlock(text, 'comments', buildCommentBlock({
        ...fixed,
        // 面板没暴露的三项沿用文件里的值，别把它们悄悄重置
        strict: prev.strict,
        emitMetadata: prev.emitMetadata,
        loading: prev.loading,
      }));

      if (next === text) {
        result.textContent = '设置没有变化';
        result.className = 'conn-result';
        return;
      }

      try {
        await putFile(path, next, 'config: 更新 giscus 评论设置', sha);
        saved = true;
      } catch (e) {
        if (e.status !== 409) throw e;
        if (attempt === 3) {
          throw new Error('文件刚被其他提交改过，重试 3 次仍然冲突，请刷新页面后再保存');
        }
      }
    }

    result.textContent = enable
      ? '已保存。构建完成后文章页底部出现评论区；第一条评论会自动在 Discussions 里建帖。'
      : '已保存。评论已关闭，文章页不再加载 giscus。';
    result.className = 'conn-result ok';
    toast('评论设置已提交');
  } catch (e) {
    result.textContent = `保存失败：${e.message}`;
    result.className = 'conn-result bad';
    toast(`保存失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/** 预设诗句库，安装主题时写入 source/motto.txt（一行一句，格式：句子 —— 出处） */
const MOTTO_PRESET = `星垂平野阔，月涌大江流。 —— 《旅夜书怀》· 唐代 · 杜甫
长风破浪会有时，直挂云帆济沧海。 —— 《行路难·其一》· 唐代 · 李白
会当凌绝顶，一览众山小。 —— 《望岳》· 唐代 · 杜甫
千磨万击还坚劲，任尔东西南北风。 —— 《竹石》· 清代 · 郑燮
沉舟侧畔千帆过，病树前头万木春。 —— 《酬乐天扬州初逢席上见赠》· 唐代 · 刘禹锡
海内存知己，天涯若比邻。 —— 《送杜少府之任蜀州》· 唐代 · 王勃
落霞与孤鹜齐飞，秋水共长天一色。 —— 《滕王阁序》· 唐代 · 王勃
山重水复疑无路，柳暗花明又一村。 —— 《游山西村》· 宋代 · 陆游
不经一番寒彻骨，怎得梅花扑鼻香。 —— 《上堂开示颂》· 唐代 · 黄檗禅师
路漫漫其修远兮，吾将上下而求索。 —— 《离骚》· 战国 · 屈原
大鹏一日同风起，扶摇直上九万里。 —— 《上李邕》· 唐代 · 李白
莫愁前路无知己，天下谁人不识君。 —— 《别董大》· 唐代 · 高适
生当作人杰，死亦为鬼雄。 —— 《夏日绝句》· 宋代 · 李清照
天行健，君子以自强不息。 —— 《周易·乾卦》
博观而约取，厚积而薄发。 —— 《稼说送张琥》· 宋代 · 苏轼
纸上得来终觉浅，绝知此事要躬行。 —— 《冬夜读书示子聿》· 宋代 · 陆游
问渠那得清如许？为有源头活水来。 —— 《观书有感》· 宋代 · 朱熹
衣带渐宽终不悔，为伊消得人憔悴。 —— 《蝶恋花》· 宋代 · 柳永
众里寻他千百度，蓦然回首，那人却在，灯火阑珊处。 —— 《青玉案·元夕》· 宋代 · 辛弃疾
江山代有才人出，各领风骚数百年。 —— 《论诗五绝·其二》· 清代 · 赵翼
人生自古谁无死，留取丹心照汗青。 —— 《过零丁洋》· 宋代 · 文天祥
粉骨碎身浑不怕，要留清白在人间。 —— 《石灰吟》· 明代 · 于谦
千锤万凿出深山，烈火焚烧若等闲。 —— 《石灰吟》· 明代 · 于谦
咬定青山不放松，立根原在破岩中。 —— 《竹石》· 清代 · 郑燮
宝剑锋从磨砺出，梅花香自苦寒来。 —— 《警世贤文》
业精于勤荒于嬉，行成于思毁于随。 —— 《进学解》· 唐代 · 韩愈
读书破万卷，下笔如有神。 —— 《奉赠韦左丞丈二十二韵》· 唐代 · 杜甫
黑发不知勤学早，白首方悔读书迟。 —— 《劝学》· 唐代 · 颜真卿
少年易老学难成，一寸光阴不可轻。 —— 《偶成》· 宋代 · 朱熹
盛年不重来，一日难再晨。 —— 《杂诗》· 东晋 · 陶渊明
及时当勉励，岁月不待人。 —— 《杂诗》· 东晋 · 陶渊明
莫等闲，白了少年头，空悲切。 —— 《满江红》· 宋代 · 岳飞
天生我材必有用，千金散尽还复来。 —— 《将进酒》· 唐代 · 李白
仰天大笑出门去，我辈岂是蓬蒿人。 —— 《南陵别儿童入京》· 唐代 · 李白
安能摧眉折腰事权贵，使我不得开心颜。 —— 《梦游天姥吟留别》· 唐代 · 李白
长风万里送秋雁，对此可以酣高楼。 —— 《宣州谢朓楼饯别校书叔云》· 唐代 · 李白
俱怀逸兴壮思飞，欲上青天揽明月。 —— 《宣州谢朓楼饯别校书叔云》· 唐代 · 李白
抽刀断水水更流，举杯销愁愁更愁。 —— 《宣州谢朓楼饯别校书叔云》· 唐代 · 李白
欲穷千里目，更上一层楼。 —— 《登鹳雀楼》· 唐代 · 王之涣
黄河远上白云间，一片孤城万仞山。 —— 《凉州词》· 唐代 · 王之涣
羌笛何须怨杨柳，春风不度玉门关。 —— 《凉州词》· 唐代 · 王之涣
秦时明月汉时关，万里长征人未还。 —— 《出塞》· 唐代 · 王昌龄
但使龙城飞将在，不教胡马度阴山。 —— 《出塞》· 唐代 · 王昌龄
黄沙百战穿金甲，不破楼兰终不还。 —— 《从军行》· 唐代 · 王昌龄
醉卧沙场君莫笑，古来征战几人回。 —— 《凉州词》· 唐代 · 王翰
葡萄美酒夜光杯，欲饮琵琶马上催。 —— 《凉州词》· 唐代 · 王翰
大漠孤烟直，长河落日圆。 —— 《使至塞上》· 唐代 · 王维
明月松间照，清泉石上流。 —— 《山居秋暝》· 唐代 · 王维
行到水穷处，坐看云起时。 —— 《终南别业》· 唐代 · 王维
空山新雨后，天气晚来秋。 —— 《山居秋暝》· 唐代 · 王维
劝君更尽一杯酒，西出阳关无故人。 —— 《送元二使安西》· 唐代 · 王维
春眠不觉晓，处处闻啼鸟。 —— 《春晓》· 唐代 · 孟浩然
绿树村边合，青山郭外斜。 —— 《过故人庄》· 唐代 · 孟浩然
野旷天低树，江清月近人。 —— 《宿建德江》· 唐代 · 孟浩然
两个黄鹂鸣翠柳，一行白鹭上青天。 —— 《绝句》· 唐代 · 杜甫
无边落木萧萧下，不尽长江滚滚来。 —— 《登高》· 唐代 · 杜甫
风急天高猿啸哀，渚清沙白鸟飞回。 —— 《登高》· 唐代 · 杜甫
蜀道之难，难于上青天。 —— 《蜀道难》· 唐代 · 李白
飞流直下三千尺，疑是银河落九天。 —— 《望庐山瀑布》· 唐代 · 李白
两岸猿声啼不住，轻舟已过万重山。 —— 《早发白帝城》· 唐代 · 李白
孤帆远影碧空尽，唯见长江天际流。 —— 《黄鹤楼送孟浩然之广陵》· 唐代 · 李白
故人西辞黄鹤楼，烟花三月下扬州。 —— 《黄鹤楼送孟浩然之广陵》· 唐代 · 李白
桃花潭水深千尺，不及汪伦送我情。 —— 《赠汪伦》· 唐代 · 李白
春江潮水连海平，海上明月共潮生。 —— 《春江花月夜》· 唐代 · 张若虚
江畔何人初见月？江月何年初照人？ —— 《春江花月夜》· 唐代 · 张若虚
海上生明月，天涯共此时。 —— 《望月怀远》· 唐代 · 张九龄
曾经沧海难为水，除却巫山不是云。 —— 《离思五首·其四》· 唐代 · 元稹
春蚕到死丝方尽，蜡炬成灰泪始干。 —— 《无题》· 唐代 · 李商隐
身无彩凤双飞翼，心有灵犀一点通。 —— 《无题》· 唐代 · 李商隐
夕阳无限好，只是近黄昏。 —— 《乐游原》· 唐代 · 李商隐
相逢意气为君饮，系马高楼垂柳边。 —— 《少年行》· 唐代 · 王维
同是天涯沦落人，相逢何必曾相识。 —— 《琵琶行》· 唐代 · 白居易
此情可待成追忆，只是当时已惘然。 —— 《锦瑟》· 唐代 · 李商隐
独在异乡为异客，每逢佳节倍思亲。 —— 《九月九日忆山东兄弟》· 唐代 · 王维
举头望明月，低头思故乡。 —— 《静夜思》· 唐代 · 李白
慈母手中线，游子身上衣。 —— 《游子吟》· 唐代 · 孟郊
谁言寸草心，报得三春晖。 —— 《游子吟》· 唐代 · 孟郊
少小离家老大回，乡音无改鬓毛衰。 —— 《回乡偶书》· 唐代 · 贺知章
但愿人长久，千里共婵娟。 —— 《水调歌头》· 宋代 · 苏轼
人有悲欢离合，月有阴晴圆缺，此事古难全。 —— 《水调歌头》· 宋代 · 苏轼
十年生死两茫茫，不思量，自难忘。 —— 《江城子·乙卯正月二十日夜记梦》· 宋代 · 苏轼
莫听穿林打叶声，何妨吟啸且徐行。 —— 《定风波》· 宋代 · 苏轼
回首向来萧瑟处，归去，也无风雨也无晴。 —— 《定风波》· 宋代 · 苏轼
大江东去，浪淘尽，千古风流人物。 —— 《念奴娇·赤壁怀古》· 宋代 · 苏轼
枝上柳绵吹又少，天涯何处无芳草。 —— 《蝶恋花·春景》· 宋代 · 苏轼
不识庐山真面目，只缘身在此山中。 —— 《题西林壁》· 宋代 · 苏轼
竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。 —— 《定风波》· 宋代 · 苏轼
春花秋月何时了？往事知多少。 —— 《虞美人》· 五代 · 李煜
问君能有几多愁？恰似一江春水向东流。 —— 《虞美人》· 五代 · 李煜
无言独上西楼，月如钩。 —— 《相见欢》· 五代 · 李煜
剪不断，理还乱，是离愁。 —— 《相见欢》· 五代 · 李煜
醉里挑灯看剑，梦回吹角连营。 —— 《破阵子》· 宋代 · 辛弃疾
了却君王天下事，赢得生前身后名。 —— 《破阵子》· 宋代 · 辛弃疾
稻花香里说丰年，听取蛙声一片。 —— 《西江月·夜行黄沙道中》· 宋代 · 辛弃疾
东风夜放花千树，更吹落，星如雨。 —— 《青玉案·元夕》· 宋代 · 辛弃疾
欲把西湖比西子，淡妆浓抹总相宜。 —— 《饮湖上初晴后雨》· 宋代 · 苏轼
接天莲叶无穷碧，映日荷花别样红。 —— 《晓出净慈寺送林子方》· 宋代 · 杨万里
春色满园关不住，一枝红杏出墙来。 —— 《游园不值》· 宋代 · 叶绍翁
等闲识得东风面，万紫千红总是春。 —— 《春日》· 宋代 · 朱熹
疏影横斜水清浅，暗香浮动月黄昏。 —— 《山园小梅》· 宋代 · 林逋
黄梅时节家家雨，青草池塘处处蛙。 —— 《约客》· 宋代 · 赵师秀
梅须逊雪三分白，雪却输梅一段香。 —— 《雪梅》· 宋代 · 卢梅坡
不要人夸好颜色，只留清气满乾坤。 —— 《墨梅》· 元代 · 王冕
不要愁老之将至，你老了一定很可爱。 —— 朱生豪·宋清如
落红不是无情物，化作春泥更护花。 —— 《己亥杂诗》· 清代 · 龚自珍
我劝天公重抖擞，不拘一格降人才。 —— 《己亥杂诗》· 清代 · 龚自珍
海到无边天作岸，山登绝顶我为峰。 —— 《出老》· 清代 · 林则徐
苟利国家生死以，岂因祸福避趋之。 —— 《赴戍登程口占示家人》· 清代 · 林则徐
化作春泥更护花。 —— 《己亥杂诗》· 清代 · 龚自珍
`;

/* ============================================================
 *  浏览量（GoatCounter）
 *  配置同样写站点 _config.yml（views 段），不跟主题配置走。
 * ============================================================ */
const VIEW_DEFAULTS = { enable: false, code: '', label: '阅读' };

/** 读某个顶层段里的扁平标量（一行一个 key: value） */
function readBlockValues(text, key) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const range = findTopLevelBlock(lines, key);
  if (!range) return null;

  const out = {};
  for (const line of lines.slice(range.start, range.end)) {
    const m = /^\s{1,4}([A-Za-z][\w]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = unquoteYaml(m[2]);
  }
  return out;
}

/** 从站点 _config.yml 读浏览量配置 */
function readViewSettings(text) {
  const cfg = { ...VIEW_DEFAULTS };
  const vals = readBlockValues(text, 'views');
  if (!vals) return cfg;

  cfg.enable = vals.enable === 'true' || vals.enable === '1';
  if (vals.code) cfg.code = vals.code;
  if (vals.label) cfg.label = vals.label;
  return cfg;
}

/** 生成 views 段 */
function buildViewBlock(c) {
  const q = (v) => `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;
  return [
    '# ==================== 浏览量（GoatCounter） ====================',
    '# 免费、无 Cookie 的访客统计，需要在 https://www.goatcounter.com 建一个站点，',
    '# 并在站点 Settings 里打开 “Allow adding visitor counts on your website”。',
    'views:',
    `  enable: ${c.enable ? 'true' : 'false'}`,
    `  code: ${q(c.code)}`,
    `  label: ${q(c.label)}`,
  ].join('\n');
}

/** 把仓库里的浏览量配置填进设置面板 */
async function loadViewSettings() {
  if (!settingsReady()) return;
  try {
    const { text } = await getFile('_config.yml');
    const cfg = readViewSettings(text);
    $('#fViewEnable').checked = cfg.enable;
    $('#fViewCode').value = cfg.code;
    $('#fViewLabel').value = cfg.label;
  } catch { /* 站点还没初始化，忽略 */ }
}

/** 校验并写回站点 _config.yml */
async function saveViewSettings() {
  if (!settingsReady()) { toast('请先配置仓库', true); return; }

  const btn = $('#btnSaveViews');
  const result = $('#viewResult');
  btn.disabled = true;

  try {
    const enable = $('#fViewEnable').checked;
    const code = $('#fViewCode').value.trim().toLowerCase();
    const label = $('#fViewLabel').value.trim() || '阅读';

    if (enable && !code) throw new Error('启用浏览量前要填站点代码');
    if (code && !/^[a-z0-9][a-z0-9-]*$/.test(code)) {
      throw new Error('站点代码只能用小写字母、数字和连字符（如 yourcode）');
    }

    const path = '_config.yml';
    let saved = false;

    // 和评论设置一样：409 说明 sha 过期，重新读再写，最多 3 次
    for (let attempt = 1; attempt <= 3 && !saved; attempt += 1) {
      const { text, sha } = await getFile(path);
      const next = writeTopLevelBlock(text, 'views', buildViewBlock({ enable, code, label }));

      if (next === text) {
        result.textContent = '设置没有变化';
        result.className = 'conn-result';
        return;
      }

      try {
        await putFile(path, next, 'config: 更新浏览量设置', sha);
        saved = true;
      } catch (e) {
        if (e.status !== 409) throw e;
        if (attempt === 3) throw new Error('文件刚被其他提交改过，重试 3 次仍然冲突，请刷新页面后再保存');
      }
    }

    result.textContent = enable
      ? '已保存。构建完成后文章页会出现「阅读 N」；GoatCounter 后台约 10 秒后能看到这次访问。'
      : '已保存。浏览量已关闭，主题不再加载统计脚本。';
    result.className = 'conn-result ok';
    toast('浏览量设置已提交');
  } catch (e) {
    result.textContent = `保存失败：${e.message}`;
    result.className = 'conn-result bad';
    toast(`保存失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function installCnblogTheme() {
  if (!settingsReady()) { toast('请先填写仓库信息和 Token', true); return; }

  const pack = window.CNBLOG_THEME;
  if (!pack) { toast('主题包没有加载（theme-cnblog.js）', true); return; }

  const textFiles = pack.files || pack;
  const assets = pack.assets || {};

  // 防呆：包里的键就是提交路径，必须带 themes/cnblog/ 前缀。
  // 生成脚本曾把基准目录写成 themes/cnblog，键变成 layout/post.ejs，
  // 装主题时直接写到仓库根目录，把站点 _config.yml 覆盖成了主题配置。
  const badPackPath = [...Object.keys(textFiles), ...Object.keys(assets)]
    .find((p) => !p.startsWith('themes/cnblog/'));
  if (badPackPath) {
    toast(`主题包路径异常（缺少 themes/cnblog/ 前缀）：${badPackPath}`, true);
    setStatus('主题包路径异常，已中止，避免写坏仓库');
    return;
  }

  // 主题配置里带的是打包时的示例信息，装机时换成当前仓库主人，
  // 这样把后台分享出去，别人装出来是自己的站点而不是原作者的。
  const themeCfgPath = 'themes/cnblog/_config.yml';
  if (textFiles[themeCfgPath]) {
    textFiles[themeCfgPath] = textFiles[themeCfgPath]
      .replace(/^author:.*$/m, `author: ${state.settings.owner}`)
      .replace(/^avatar:.*$/m, 'avatar: ')
      .replace(/^intro:.*$/m, `intro: 这里是 ${state.settings.owner} 的博客。`)
      .replace(/^(  copyright:).*$/m, `$1 ${state.settings.owner}`);
  }

  const allPaths = [...Object.keys(textFiles), ...Object.keys(assets)];

  const siteCfg = '_config.yml';
  let cfgText = null;
  try {
    cfgText = (await getFile(siteCfg)).text;
  } catch {
    toast('仓库里还没有 _config.yml，请先初始化 Hexo 站点', true);
    return;
  }

  // 坏包事故会把站点 _config.yml 覆盖成主题配置（只有 mottoSource/banner，
  // 没有 title/url/theme）。这种情况不能只替换 theme: 行，要整份恢复。
  let restoredCfg = false;
  if (!/^theme:/m.test(cfgText) && /^mottoSource:/m.test(cfgText)) {
    const skeletonCfg = buildHexoFiles().find((f) => f.path === '_config.yml');
    if (skeletonCfg) {
      cfgText = skeletonCfg.content;
      restoredCfg = true;
    }
  }

  const nextCfg = /^theme:/m.test(cfgText)
    ? cfgText.replace(/^theme:.*$/m, 'theme: cnblog')
    : `${cfgText.replace(/\s*$/, '')}\ntheme: cnblog\n`;

  // 上次坏包留下的根目录副本。只清理 layout/ 和 source/css|js 下的文本文件，
  // 而且要内容和主题包完全一致才删，避免误删用户自己的文件。
  const strayPairs = Object.keys(textFiles)
    .filter((p) => p.startsWith('themes/cnblog/'))
    .map((p) => ({ packPath: p, strayPath: p.slice('themes/cnblog/'.length) }))
    .filter(({ strayPath }) => /^(layout\/|source\/(css|js)\/)/.test(strayPath));

  let hasStray = false;
  try { await getFile('layout/post.ejs'); hasStray = true; } catch { /* 正常，没有副本 */ }

  const notes = [];
  if (restoredCfg) notes.push('站点 _config.yml 被写成了主题配置，会一并恢复');
  if (hasStray) notes.push('检测到上次误写到根目录的主题副本，会一并清理');

  if (!confirm(
    `将提交 ${allPaths.length} 个主题文件（含字体与 banner 图片）到 themes/cnblog/，`
    + '并创建分类、标签索引页，最后把站点主题切换为 cnblog。'
    + (notes.length ? `\n\n另外：${notes.join('；')}。` : '')
    + '\n\n继续吗？'
  )) return;

  const btn = $('#btnInstallTheme');
  btn.disabled = true;
  setStatus('正在安装主题…');

  try {
    const changes = [];
    for (const [p, content] of Object.entries(textFiles)) changes.push({ path: p, content });
    for (const [p, b64] of Object.entries(assets)) changes.push({ path: p, base64: b64 });

    // scripts/ 在站点根目录，只由「初始化」生成；装主题时也一并更新，
    // 否则 TOC 去重、图片 referrerpolicy 这些 filter 不会生效
    const skeleton = buildHexoFiles();
    const injectScript = skeleton.find((f) => f.path === 'scripts/inject-katex.js');
    if (injectScript) changes.push({ path: injectScript.path, content: injectScript.content });

    // package.json 可能缺依赖：_config.yml 的 markdown.plugins 里列了
    // markdown-it-task-lists，但 package.json 没装它时 hexo-renderer-markdown-it
    // 加载失败，Hexo 只复制静态资源、不生成任何页面——构建还显示成功，线上全是 404。
    let depsFixed = false;
    const skeletonPkg = skeleton.find((f) => f.path === 'package.json');
    if (skeletonPkg) {
      try {
        const curPkg = JSON.parse((await getFile('package.json')).text);
        const wantDeps = JSON.parse(skeletonPkg.content).dependencies || {};
        curPkg.dependencies = curPkg.dependencies || {};
        for (const [name, ver] of Object.entries(wantDeps)) {
          if (!curPkg.dependencies[name]) {
            curPkg.dependencies[name] = ver;
            depsFixed = true;
          }
        }
        if (depsFixed) {
          changes.push({ path: 'package.json', content: `${JSON.stringify(curPkg, null, 2)}\n` });
        }
      } catch { /* 没有 package.json 或内容不合法，交给「初始化」处理 */ }
    }

    if (nextCfg !== cfgText) changes.push({ path: siteCfg, content: nextCfg });

    // 分类 / 标签索引页：缺了它们导航里的两个链接就会 404
    const pages = [
      {
        path: 'source/categories/index.md',
        content: '---\ntitle: 分类\nlayout: category\ntype: categories\n---\n',
      },
      {
        path: 'source/tags/index.md',
        content: '---\ntitle: 标签\nlayout: tag\ntype: tags\n---\n',
      },
    ];
    for (const page of pages) {
      let exists = false;
      try { await getFile(page.path); exists = true; } catch { /* 不存在 */ }
      if (!exists) changes.push(page);
    }

    // 预设诗句库，已有 motto.txt 就不覆盖用户自己的
    let hasMotto = false;
    try { await getFile('source/motto.txt'); hasMotto = true; } catch { /* 不存在 */ }
    if (!hasMotto) changes.push({ path: 'source/motto.txt', content: MOTTO_PRESET });

    // 自愈：删掉坏包写到根目录的副本（内容必须和主题包完全一样才删）
    // 读回来的文本会被 TextDecoder 吃掉 BOM，比较前两边都剥掉
    const noBom = (s) => String(s == null ? '' : s).replace(/^\uFEFF/, '');
    const cleaned = [];
    for (const { packPath, strayPath } of strayPairs) {
      try {
        const cur = await getFile(strayPath);
        if (noBom(cur.text) === noBom(textFiles[packPath])) {
          changes.push({ path: strayPath, sha: null });
          cleaned.push(strayPath);
        }
      } catch { /* 不存在，跳过 */ }
    }

    await commitFiles(changes, 'feat: 安装博客园风格主题', '安装主题');

    const done = [];
    if (restoredCfg) done.push('已恢复站点 _config.yml');
    if (cleaned.length) done.push(`已清理 ${cleaned.length} 个误写文件`);
    if (depsFixed) done.push('已补全 package.json 依赖');
    toast('主题已安装，Actions 构建完成后生效');
    setStatus(`已提交 ${changes.length} 个文件，主题切换为 cnblog${done.length ? '；' + done.join('，') : ''}`);
  } catch (e) {
    toast(`安装失败：${e.message}`, true);
    setStatus(`安装失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
 *  设置
 * ============================================================ */
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch { /* ignore */ }
  fillSettingsForm();
}

function fillSettingsForm() {
  const s = state.settings;
  $('#sOwner').value = s.owner;
  $('#sRepo').value = s.repo;
  $('#sBranch').value = s.branch;
  $('#sToken').value = s.token;
  $('#sPosts').value = s.postsPath;
  $('#sImages').value = s.imagesPath;
  $('#sPrefix').value = s.imagePrefix;
  $('#sSiteUrl').value = s.siteUrl;
  $('#sFramework').value = s.framework;

  const repoLinkEl = $('#repoLink');
  if (repoLinkEl) {
    repoLinkEl.textContent = s.owner && s.repo ? `${s.owner}/${s.repo}` : '未配置仓库';
  }
}

function readSettingsForm() {
  const s = state.settings;
  s.owner = $('#sOwner').value.trim();
  s.repo = $('#sRepo').value.trim();
  s.branch = $('#sBranch').value.trim() || 'main';
  s.token = $('#sToken').value.trim();
  s.postsPath = $('#sPosts').value.trim() || 'source/_posts';
  s.imagesPath = $('#sImages').value.trim() || 'source/images';
  s.imagePrefix = $('#sPrefix').value.trim() || '/images';
  s.siteUrl = $('#sSiteUrl').value.trim();
  s.framework = $('#sFramework').value;
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  fillSettingsForm();
  updateVisitSite();
}

function openSettings() {
  fillSettingsForm();
  $('#connResult').textContent = '';
  $('#connResult').className = 'conn-result';
  $('#mottoResult').textContent = '';
  $('#mottoResult').className = 'conn-result';
  $('#commentResult').textContent = '';
  $('#commentResult').className = 'conn-result';
  $('#viewResult').textContent = '';
  $('#viewResult').className = 'conn-result';
  $('#settingsDialog').showModal();
  loadMottoSettings();
  loadCommentSettings();
  loadViewSettings();
}

/** 用表单里当前填的值探测一次仓库，把结果直接显示在对话框里 */
async function testConnection() {
  const el = $('#connResult');
  el.className = 'conn-result';
  el.textContent = '正在连接…';

  readSettingsForm();

  try {
    const repo = await probeRepo();
    const notes = [];
    if (repo.isPrivate) notes.push('私有仓库无法用 GitHub Pages 发布');
    if (repo.defaultBranch && repo.defaultBranch !== state.settings.branch) {
      notes.push(`默认分支是 ${repo.defaultBranch}`);
    }
    // 站点头换成自定义域名以外的拼写错误
    if (state.settings.siteUrl) {
      try {
        const host = new URL(state.settings.siteUrl).hostname;
        const expect = `${state.settings.owner.toLowerCase()}.github.io`;
        if (host.endsWith('.github.io') && host !== expect) {
          notes.push(`站点域名是 ${host}，按用户名应为 ${expect}`);
        }
      } catch { /* 地址不合法时略过 */ }
    }
    el.className = 'conn-result ok';
    el.textContent = `连接成功：${repo.fullName}`
      + (notes.length ? `（${notes.join('；')}）` : '，token 权限正常');
  } catch (e) {
    el.className = 'conn-result bad';
    const hint = e.status === 404
      ? '检查用户名/仓库名，以及 token 是否勾选了这个仓库并给了 Contents 权限'
      : e.status === 401
        ? 'token 可能填错、过期或被撤销'
        : e.status === 403
          ? 'token 权限不足，或触发了 API 限流'
          : '检查网络或代理设置';
    el.textContent = `连接失败：${e.message}（${hint}）`;
  }
}

/* ============================================================
 *  事件绑定
 * ============================================================ */
function bindEvents() {
  $('#btnSaveLocal').addEventListener('click', () => saveLocal());
  $('#btnPullArchive').addEventListener('click', downloadSourceArchive);
  $('#btnPushAll').addEventListener('click', pushAllDiff);
  $('#btnAttach').addEventListener('click', () => $('#fileAttach').click());
  $('#fileAttach').addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) uploadAttachments([...files]);
    e.target.value = '';
  });
  $('#btnImportArchive').addEventListener('click', () => $('#fileArchive').click());
  $('#fileArchive').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importArchive(f);
    e.target.value = '';
  });

  // Ctrl+S 保存到本地；Ctrl+Alt+S 上传「当前这篇文章」（单文件，不弹确认）。
  // 全局批量上传留给「↑ 仓库」按钮，那里才需要确认。
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    if (e.altKey) publish();
    else saveLocal();
  });

  $('#btnNewRow') && $('#btnNewRow').addEventListener('click', () => {
    if (editor.value().trim() && !confirm('当前内容尚未发布，确定新建？')) return;
    newDocument();
  });

  $('#btnPublish').addEventListener('click', publish);

  $('#btnSettings').addEventListener('click', openSettings);

  // 点遮罩关闭对话框：<dialog> 默认只有 Esc 能关，用户容易卡住
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
  });

  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) await importMarkdown(f);
  });

  // 导入 .md 后补齐本地图片
  $('#btnPickImages').addEventListener('click', () => $('#fileImages').click());
  $('#fileImages').addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) await uploadPendingImages(files);
  });
  $('#btnIgnoreImages').addEventListener('click', () => {
    state.pendingLocalImages = [];
    showImageHint('');
    setStatus('已忽略未上传的本地图片');
  });

  $('#btnInstallWorkflow').addEventListener('click', installScheduledWorkflow);
  $('#btnInstallTheme').addEventListener('click', installCnblogTheme);
  $('#btnSaveMotto').addEventListener('click', saveMottoSettings);
  $('#btnSaveComments').addEventListener('click', saveCommentSettings);
  $('#btnSaveViews').addEventListener('click', saveViewSettings);
  $('#fMottoSource').addEventListener('change', toggleMottoRows);
  $('#btnDownloadMotto').addEventListener('click', downloadMottoFile);
  $('#fMottoFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) uploadMottoFile(file);
    e.target.value = '';
  });
  $('#btnTestConn').addEventListener('click', testConnection);
  $('#btnCheckPerm').addEventListener('click', checkTokenPermissions);
  $('#btnInitHexo').addEventListener('click', initHexoSite);
  $('#btnRemoveHexo').addEventListener('click', removeHexoSkeleton);
  $('#textDialogCopy').addEventListener('click', copyTextDialog);

  // 填了站点地址后，按子路径自动推导图片前缀（仓库名非 *.github.io 时站点在 /blog/ 下）
  $('#sSiteUrl').addEventListener('blur', () => {
    const site = $('#sSiteUrl').value.trim();
    const prefix = $('#sPrefix').value.trim();
    if (!site || (prefix && prefix !== '/images')) return;
    try {
      const base = new URL(site).pathname.replace(/\/+$/, '');
      $('#sPrefix').value = `${base}/images`;
    } catch { /* 地址不合法就不动 */ }
  });

  // 刷新 = 重新拉列表 + 严格比对本地与仓库的内容差异（不看历史标记）
  // 拖到列表空白处 = 移动到根目录（不分到任何分类里）
  $('#postList').addEventListener('dragover', (e) => {
    if (draggingPaths.length) e.preventDefault();
  });
  $('#postList').addEventListener('drop', async (e) => {
    if (e.target.closest('.tree-row')) return;   // 行上有自己的处理
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    const paths = raw.split('\n').filter(Boolean);
    const targets = state.posts.filter((p) => paths.includes(p.path));
    if (targets.length > 1) await moveSelected(targets, null);
    else if (targets.length === 1) await movePostTo(targets[0], null);
  });

  // 表单字段（标题/分类/标签/密码/摘要/日期/文件名）改动也走自动保存
  ['#fTitle', '#fCategories', '#fTags', '#fPassword', '#fExcerpt', '#fDate', '#fSlug'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => scheduleAutoSave());
    el.addEventListener('change', () => scheduleAutoSave());
  });

  // 文件树空白处右键：新建文章 / 新建分类
  $('#postList').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-row')) return;   // 行上有自己的处理
    openBlankMenu(e);
  });

  // 点别处 / 按 Esc 关闭右键菜单
  document.addEventListener('click', () => treeUI.hideCtxMenu());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') treeUI.hideCtxMenu(); });
  window.addEventListener('blur', () => treeUI.hideCtxMenu());
  window.addEventListener('resize', () => treeUI.hideCtxMenu());

  $('#btnRefresh').addEventListener('click', async () => {
    await loadPosts();
    if (!settingsReady()) return;
    const btn = $('#btnRefresh');
    btn.disabled = true;
    setStatus('正在严格比对本地与仓库…');
    try {
      const status = await strictCompare();
      const n = [...status.values()].filter((v) => v.status !== 'same').length;
      setStatus(n ? `比对完成：${n} 个文件与仓库不一致` : '比对完成：本地与仓库完全一致');
    } catch (e) {
      toast(`比对失败：${e.message}`, true);
      setStatus(`比对失败：${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  $('#search').addEventListener('input', renderList);

  $('#btnToggleMeta').addEventListener('click', () => {
    const box = document.querySelector('.meta');
    box.classList.toggle('collapsed');
    $('#btnToggleMeta').textContent = box.classList.contains('collapsed') ? '展开' : '收起';
  });



  $('#btnOrganize').addEventListener('click', reorganizePosts);
  $('#btnMigrateImages').addEventListener('click', migrateCurrentPost);
  $('#btnMoveCategory').addEventListener('click', batchMoveCategory);

  $('#settingsDialog').addEventListener('close', async () => {
    const dlg = $('#settingsDialog');
    if (dlg.returnValue !== 'save') return;
    readSettingsForm();
    if (!settingsReady()) { toast('仓库信息和 Token 都必填', true); return; }
    updateVisitSite();
    await loadPosts();
  });

  // 自动生成 slug
  $('#fTitle').addEventListener('blur', () => {
    if (!$('#fSlug').value && $('#fTitle').value.trim()) {
      $('#fSlug').value = slugify($('#fTitle').value);
    }
  });

  // Ctrl/Cmd + S 保存到本地由前面统一处理（Ctrl+S 保存，Ctrl+Alt+S 上传），
  // 这里不能再绑 publish，否则会被后注册的监听抢先触发上传。

  // 拖拽 .md 文件到窗口即导入（图片拖拽由 EasyMDE 自己处理）
  document.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    const mdFile = files.find((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (!mdFile) return;
    e.preventDefault();
    await importMarkdown(mdFile);
  });

  // 离开前提醒
  window.addEventListener('beforeunload', (e) => {
    if (editor && editor.value().trim() && !state.current.path) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ============================================================
 *  启动
 * ============================================================ */
async function init() {
  loadSettings();
  loadTitleCache();
  loadExpanded();
  buildEditor();
  fillForm({ date: new Date() });
  bindEvents();
  updateWordCount();
  updateVisitSite();

  if (settingsReady()) {
    await loadPosts();

    refreshActionStatus();
  } else {
    setStatus('请先完成设置');
    // 首次使用直接弹设置；?skip 仅供调试界面
    if (!new URLSearchParams(location.search).has('skip')) openSettings();
  }
}

init();

// 调试/测试入口：仅在控制台或自动化测试中使用
window.__blog = {
  state,
  saveLocal,
  openPost,
  pushAllDiff,
  downloadSourceArchive,
  importArchive,
  refreshLocalDiff,
  strictCompare,
  reorderBeside,
  contentOfPost,
  refreshDiffFromState,
  localStoreList: () => localStore.listLocal(),
  localStoreClear: () => localStore.clearLocal(),
  hashContent: (s) => localStore.hashContent(s),
  normalizeMathBlocks,
  protectLatexNewlines,
  extractMathBlocks,
  renderTaskHeadings,
  restoreMathBlocks,
  setupScrollSync,
  restoreLatexNewlines,
  normalizeInlineMath,
  buildFrontMatter,
  splitFrontMatter,
  slugify,
  toList,
  getFile,
  putFile,
  publish,
  uploadImage,
  importMarkdown,
  findLocalImageRefs,
  buildScheduledWorkflow,
  installScheduledWorkflow,
  enrichTitles,
  loadPosts,
  probeRepo,
  testConnection,
  buildHexoFiles,
  buildScheduledWorkflow,
  commitFiles,
  deriveSite,
  initHexoSite,
  removeHexoSkeleton,
  showTextDialog,
  checkTokenPermissions,
  tokenKind,
  rawApi,
  installCnblogTheme,
  loadMottoSettings,
  uploadMottoFile,
  downloadMottoFile,
  toggleMottoRows,
  saveMottoSettings,
  loadCommentSettings,
  saveCommentSettings,
  loadViewSettings,
  saveViewSettings,
  readViewSettings,
  readCommentSettings,
  buildCommentBlock,
  writeTopLevelBlock,
  refreshActionStatus,
  describeRun,
  renderActionBadge,
  pollActionsOnce,
  actionWatch,
  startActionWatch,
  migrateExternalImages,
  migrateAllPostsImages,
  batchMoveCategory,
  insertCategoryPrefix,
  findExternalRefs,
  findLocalRefs,
  checkLocalRefs,
  localRefToRepoPath,
  migrateCurrentPost,
  uploadAttachment,
  uploadAttachments,
  postUrl,
  guessPermalink,
  sanitizeFolder,
  reorganizePosts,
  updateVisitSite,
  UNCATEGORIZED,
  renderList,
  buildTree,
  matchesQuery,
  get editor() { return editor; },
};