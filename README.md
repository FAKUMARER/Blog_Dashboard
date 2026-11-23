# 博客后台（GitHub Pages + Hexo 可视化发布工具）

一个**纯静态、零后端**的博客后台。浏览器里写 Markdown、拖图、一键发布到 GitHub 仓库，由 GitHub Actions 构建并部署到 GitHub Pages。

不需要服务器、不需要数据库、不需要本地装 Hexo。整个后台就是几个 HTML/JS 文件，用任意静态服务器打开即可。

---

## 目录

1. [架构总览](#架构总览)
2. [文件清单](#文件清单)
3. [数据模型](#数据模型)
4. [核心机制](#核心机制)
5. [功能实现索引](#功能实现索引)
6. [主题结构](#主题结构)
7. [扩展指南](#扩展指南)
8. [维护者须知](#维护者须知)

---

## 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  浏览器（本地）                                                │
│                                                              │
│  admin/index.html ──┬─→ app.js        主逻辑（~5000 行）        │
│                     ├─→ local-store.js  IndexedDB 本地文件库    │
│                     ├─→ tree-ops.js    纯路径运算               │
│                     ├─→ tree-ui.js     右键菜单 + 文件搬迁      │
│                     └─→ theme-cnblog.js 主题包（自动生成）       │
│                                                              │
│  本地状态：IndexedDB（文件内容）+ localStorage（设置/标题缓存）  │
└───────────────────────────┬──────────────────────────────────┘
                            │ GitHub REST API（Bearer Token）
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  GitHub 仓库                                                  │
│                                                              │
│  source/_posts/**.md       文章                               │
│  source/images/**          图片                               │
│  themes/cnblog/**          主题                               │
│  _config.yml / package.json                                   │
│  .github/workflows/deploy.yml                                 │
└───────────────────────────┬──────────────────────────────────┘
                            │ Actions 构建
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  GitHub Pages（静态站点）                                      │
└──────────────────────────────────────────────────────────────┘
```

**设计原则**：

1. **完全无后端** —— 所有写操作直接走 GitHub API
2. **本地优先** —— 编辑先落 IndexedDB，上传是显式动作
3. **不删只标** —— 删除、移动都只改本地标记，上传时才提交
4. **纯 ESM** —— 无构建步骤，`index.html` 直接 `<script type="module">`

---

## 文件清单

### `admin/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.html` | ~340 | 页面骨架、dialogs、脚本加载顺序 |
| `app.js` | ~5000 | **主逻辑**：GitHub API、渲染、编辑器、全部业务 |
| `local-store.js` | ~180 | IndexedDB 封装、内容 hash、差异计算 |
| `tree-ops.js` | ~80 | 纯路径运算（移动、重命名、层级），无 DOM 无存储 |
| `tree-ui.js` | ~190 | 右键菜单、文件搬迁（`relocateFile`/`relocateDir`） |
| `style.css` | ~950 | 全部样式，CSS 变量支持深浅色 |
| `theme-cnblog.js` | 自动生成 | 主题文件打包成 JS 对象，供一键安装用 |

**依赖加载顺序**（`index.html` 尾部，不可乱）：

```
js-yaml.js → markdown-it.min.js → markdown-it-task-lists.min.js
→ katex.min.js → auto-render.min.js → highlight.min.js
→ easymde.min.js → jszip.min.js
→ theme-cnblog.js → app.js (module)
```

### `vendor/`

| 库 | 用途 |
|---|---|
| `js-yaml.js` | front-matter 解析/生成 |
| `markdown-it.min.js` | Markdown 渲染 |
| `markdown-it-task-lists.min.js` | `- [ ]` 任务列表 |
| `katex.min.js` + `auto-render.min.js` | 数学公式 |
| `highlight.min.js` | 代码高亮 |
| `easymde.min.js` | Markdown 编辑器 |
| `jszip.min.js` | 存档打包/解压 |
| `fa/` + `fonts/` | FontAwesome 图标、KaTeX 字体 |

---

## 数据模型

### `state`（`app.js` 内的全局单例）

```js
const state = {
  settings: {
    owner, repo, branch, token,
    siteUrl, framework,          // 'hexo' | 'hugo'
    postsPath,                   // 'source/_posts'
    imagesPath, imagePrefix,
    theme,                       // 'landscape' | 'cnblog'
  },

  posts: [                       // 文章列表（渲染源）
    {
      name,                      // '2026-01-01-xxx.md'
      path,                      // 'source/_posts/分类/2026-01-01-xxx.md'
      sha,                       // 远程 sha（null = 仓库里没有）
      folder,                    // '笔记/数论'
      localContent,              // 本地内容缓存（可选）
      isDeletedPlaceholder,      // 是否为「已移走」的删除占位
      originalContent,           // 移动前的原内容快照（用于拖回时比对）
    }
  ],

  current: { path, sha, permalink },   // 正在编辑的文章
  diff: Map<path, { status, rec }>,    // 差异表
  deletedPaths: Set<path>,             // 同步的删除标记（渲染用）
  titleCache: { [path]: { title, sha, permalink, tags, categories, date } },
  expanded: Set<dirKey>,               // 展开的文件夹
  selected: Set<path>,                 // 多选
  localDirs: Set<dirRel>,              // 只存在于本地的空分类（在 tree-ui 里维护）
}
```

### IndexedDB 记录（`local-store.js`）

数据库 `blog-admin-local`，表 `files`，主键 `path`：

```js
{
  path: 'source/_posts/笔记/2026-01-01-甲.md',
  content: '---\ntitle: 甲\n...',      // 文本内容；二进制文件存 base64
  deleted: false,                       // 标记删除（tombstone）
  ctime: 1735689600000,                 // 本地创建时间（上传排序用）
  mtime: 1735689600000,
  baseSha: 'abc123',                    // 上次同步时的远程 sha
  baseHash: 'djubor-22',                // 上次同步时的内容 hash
  isBinary: false,
}
```

**`baseSha` / `baseHash` 的作用**：判断"本地是否真的改了"。

- `hashContent(content) === baseHash` → 内容未变 → `same`
- 不等 → `modified`
- 没有远程对应文件 → `added`（或 `same`，如果曾经同步过）

### localStorage 键

| 键 | 内容 |
|---|---|
| `blog-admin:settings:v1` | 设置对象 |
| `blog-admin:titles:v2` | 标题缓存（避免每次拉全文解析标题） |
| `blog-admin:expanded:v1` | 展开的文件夹 |
| `blog-admin:localDirs:v1` | 本地空分类列表 |

---

## 核心机制

### 1. GitHub API 层

`gh(path, options)` —— 统一封装：

```js
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...opts.headers,
    },
  });
  // 出错时抛 ApiError(message, status, apiMessage)
}
```

**关键约定**：

- 抛 `ApiError`，带 `status` 和 `apiMessage`（GitHub 原始报错）
- 空仓库的错误是 **409 `Git Repository is empty`**（不是 404！）
- `commitFiles(changes, message)` 是唯一的多文件提交入口，内部用 Git Trees API 一次性提交

### 2. 差异检测（最容易搞错的部分）

有**两套**计算：

#### `refreshDiffFromState()` —— 快，不请求网络

```js
// 用 state.posts 里已知的 sha 当远程信息
const remoteShaMap = new Map(state.posts.filter(p => p.sha).map(p => [p.path, p.sha]));
state.diff = localStore.computeStatus(await localStore.listLocal(), remoteShaMap);
```

用于：自动保存后、文件操作后。

#### `strictCompare()` —— 准，逐文件拉内容比对

```js
// 拉远程树 → 对每个本地文件拉 blob → 比 hash
const tree = await gh(`/git/trees/${branch}?recursive=1`);
for (const rec of localFiles) {
  const blob = await gh(`/git/blobs/${sha}`);
  const same = hashContent(decode(blob)) === hashContent(rec.content);
}
```

用于：「⟳ 刷新」按钮。**只依赖内容，不看历史标记。**

#### `computeStatus` 的判定顺序

```js
1. rec.deleted && remoteSha        → 'deleted'
2. rec.deleted && !remoteSha       → 略过（本来就不在仓库）
3. !remoteSha:
     rec.baseSha || baseHash匹配   → 'same'（远程临时缺失，别误报新增）
     否则                          → 'added'
4. hashContent(content) === baseHash → 'same'
5. 否则                            → 'modified'
```

**第 3 条的 `same` 很关键**：GitHub 的 trees 在 commit 后有短暂延迟，不加这个会把刚上传的文件判成新增。

### 3. 本地 ⇄ 远程的状态机

```
    新建文章
       ↓
   [本地 only]  ──保存──→  [added]
       ↓                     ↓
    删除它              ↑仓库/发布
       ↓                     ↓
   [消失]              [same] ←── 打开不修改（markSynced: true）
                            ↓
                        修改并保存
                            ↓
                      [modified]
                            ↓
                        删除
                            ↓
                    [deleted] ←── 再点开 → 撤回成 [same]/[modified]
```

### 4. 移动/改名的语义

**核心规则**：源路径如果在仓库里存在过，就留一条 **tombstone**（`deleted: true`），列表里显示为「已删除」；纯本地文件直接抹掉。

```js
async function movePostTo(item, targetDirRel) {
  const targetBefore = await localStore.getLocal(newPath);   // 目标可能是个删除占位
  const actualPath = await treeUI.relocateFile(oldPath, newPath, nextContent, {
    sourceInRepo: !!item.sha,        // 决定是否留 tombstone
  });

  // 原路径补一条删除占位，让用户看到「从哪儿移走的」
  recordMovedPlaceholder(oldPath, item.sha, postsPath, content);

  // 目标原本是删除占位 → 拖回原位
  if (targetBefore && targetBefore.deleted) {
    const snapshot = ...originalContent;
    state.diff.set(newPath, { status: same ? 'same' : 'modified' });
  }
}
```

**改名同理**，而且 `applyPostRename` 会同时改 front-matter 的 `title` 和文件名（保留日期前缀）。

**多次改名只留最初那条删除占位**：因为第一次改名后 `item.sha` 被置 `null`，后续 `recordMovedPlaceholder` 的 `if (!oldSha) return` 会跳过。

### 5. Markdown 渲染管线

渲染前有一串预处理，顺序**不能乱**：

```js
const source = renderTaskHeadings(md,
  normalizeInlineMath(
    normalizeMathBlocks(
      protectLatexNewlines(text)
    )
  )
);
let html = md.render(source);
html = restoreMathBlocks(...);   // 占位符 → KaTeX HTML
```

| 步骤 | 解决什么 |
|---|---|
| `protectLatexNewlines` | `\\` 会被 markdown-it 转义成 `\`，先把 `\\` 换成占位符 |
| `normalizeMathBlocks` | `$$` 块内的空行会让 markdown 拆段落，压掉 |
| `normalizeInlineMath` | `$ x $` 两侧有空格 markdown-it-katex 不渲染，去掉 |
| `extractMathBlocks` | `$$` 块整个抽成占位符，避免 `- \sum` 被当列表 |
| `restoreMathBlocks` | 占位符换回 `katex.renderToString()` 输出 |
| `renderTaskHeadings` | `- [ ] ##### xxx` → `<input>` + `<h5>` |

**为什么这么多层**：markdown-it 的语法规则和 LaTeX 冲突（`*` 是列表也是乘号、`_` 是斜体也是下标、`\` 是转义）。占位符方案是最终解。

### 6. 上传时机

```js
// 发布（单篇）
Ctrl+Alt+S → publish() → putFile() → 立即同步本地标记

// 批量
↑ 仓库 → pushAllDiff() → commitFiles() → 标记已同步
       → ⚠️ 不立即 loadPosts()
       → pollActionsOnce() 检测到本次 sha 的 Action 成功
       → postDeployRefresh() → loadPosts()
```

**为什么上传后不立即刷新**：Action 构建期间仓库状态在变，立刻拉列表会让新建/移动的文件"消失一下"。等构建成功（用 `actionWatch.sha` 精确匹配，不会误认上一次的成功）再同步。

### 7. 主题安装

`theme-cnblog.js` 是**自动生成的**（`gen-theme-pack.cjs` 把 `themes/cnblog/` 打成一个 JS 对象）：

```js
window.CNBLOG_THEME = {
  files: { 'layout/index.ejs': '...', ... },
  assets: { 'source/img/banner.webp': 'base64...' }
};
```

`installCnblogTheme()` 遍历这个对象，逐文件 `putFile` 提交。

**改主题后必须重新生成**：`node gen-theme-pack.cjs`（脚本在项目根目录）。

---

## 功能实现索引

> 行号会随改动漂移，用它定位大致位置，然后搜索函数名。

### 基础设施

| 功能 | 文件 | 函数 / 位置 |
|---|---|---|
| GitHub 请求封装 | `app.js` 顶部 | `gh()`、`ApiError` |
| 多文件提交 | `app.js` | `commitFiles()` |
| 单文件读写 | `app.js` | `getFile()`、`putFile()` |
| 工具函数 | `app.js` 顶部 | `pool()`、`debounce()`、`b64encodeUtf8()`、`slugify()`、`fmtDateLocal()` |
| front-matter | `app.js` | `splitFrontMatter()`、`buildFrontMatter()`、`toList()` |

### 编辑与渲染

| 功能 | 函数 |
|---|---|
| 编辑器初始化 | `buildEditor()` |
| 分屏预览 | `renderSidePreview()`、`setupScrollSync()` |
| 主渲染入口 | `previewRender()` |
| Markdown 实例 | 顶层 `const md = window.markdownit({...})` |
| 公式预处理 | `protectLatexNewlines()`、`normalizeMathBlocks()`、`normalizeInlineMath()`、`extractMathBlocks()`、`restoreMathBlocks()` |
| 任务列表标题 | `renderTaskHeadings()` |
| 代码高亮 | `md` 的 `highlight` 选项 + `hljs` |

### 文章操作

| 功能 | 函数 |
|---|---|
| 打开文章 | `openPost(item)` |
| 保存到本地 | `saveLocal({ silent, refresh })` |
| 发布单篇 | `publish()` |
| 移动分类 | `movePostTo(item, targetDirRel)` |
| 重命名 | `renamePostItem()` → `applyPostRename()` |
| 重命名分类 | `renameCategory()` → `applyCategoryRename()` |
| 删除 | `deletePostItem()`、`deleteSelected()` |
| 批量上传 | `pushAllDiff()` |
| 自动保存 | `scheduleAutoSave`（debounce 1500ms）、`docFingerprint()` |

### 文件树

| 功能 | 文件 | 函数 |
|---|---|---|
| 渲染列表 | `app.js` | `renderList()`、`renderTreeNode()`、`renderFileItem()` |
| 右键菜单 | `tree-ui.js` | `showCtxMenu()`、`hideCtxMenu()` |
| 内联编辑 | `app.js` | `startInlineEdit()` |
| 拖拽 | `app.js` | `bindDragAndDrop()`、`bindFileDrop()`、`bindDirDrop()` |
| 调序 | `app.js` | `reorderBeside()` |
| 删除占位 | `app.js` | `recordMovedPlaceholder()` |
| 文件搬迁 | `tree-ui.js` | `relocateFile()`、`relocateDir()` |
| 路径运算 | `tree-ops.js` | `moveInto()`、`renameFile()`、`renameDirInPath()`、`dirname()`、`basename()` |

### 差异

| 功能 | 函数 |
|---|---|
| 状态计算 | `local-store.js` 的 `computeStatus()` |
| 快速重算 | `refreshDiffFromState()` |
| 严格比对 | `strictCompare()` |
| 合并远程信息 | `refreshLocalDiff()` |
| 按 order 排序 | `applyLocalOrder()` |

### 设置与初始化

| 功能 | 函数 |
|---|---|
| 设置面板 | `openSettings()`、`saveSettings()`、`readSettingsForm()` |
| 连接测试 | `testConnection()` |
| 站点初始化 | `initHexoSite()`、`buildHexoFiles()` |
| 主题安装 | `installCnblogTheme()` |
| 评论配置 | `loadCommentSettings()`、`saveCommentSettings()`、`readCommentSettings()`、`writeTopLevelBlock()` |
| 浏览量配置 | `loadViewSettings()`、`saveViewSettings()`、`readViewSettings()`、`readBlockValues()` |
| 定时构建 | `installScheduledWorkflow()` |
| 批量改分类 | `batchMoveCategory()`、`insertCategoryPrefix()` |
| 外链迁移 | `migrateAllPostsImages()`、`findExternalRefs()` |

### 本地存档

| 功能 | 函数 |
|---|---|
| 下载存档 | `downloadSourceArchive()` |
| 导入存档 | `importArchive(file)` |
| IndexedDB 层 | `local-store.js` 全部导出 |

### Action 监控

| 功能 | 函数 |
|---|---|
| 开始监控 | `startActionWatch(sha, title)` |
| 单次轮询 | `pollActionsOnce()` |
| 构建成功回调 | `pollActionsOnce()` 内的 `postDeployRefresh()` 调用 |
| 徽章渲染 | `renderActionBadge()` |

---

## 主题结构

`themes/cnblog/`：

```
themes/cnblog/
  _config.yml           # 主题配置（作者 / 头像 / 简介 / 格言 / 菜单 / 侧栏组件）
                        # 注意：装主题时会被整份覆盖，别把站点专属的 ID 放这里
  layout/
    layout.ejs          # 主框架（含 assetV 版本号定义）
    _partial/
      head.ejs          # <head>，用 typeof assetV 判断
      sidebar.ejs       # 侧栏：profile / 统计 / 分类 / 标签 / 最新文章 / 目录 / 同分类合集
      ...
    index.ejs           # 首页（文章卡片列表）
    post.ejs            # 文章页（末尾挂 giscus 评论区）
    archive.ejs         # 归档 / 分类 / 标签共用（分页 + 年份分组 + 摘要）
    category.ejs        # 分类索引页
    tag.ejs             # 标签索引页
  source/
    css/style.css       # 全部样式（含评论区，~30KB）
    js/main.js          # 深浅色、目录高亮、giscus 挂载与主题同步
    images/banner.webp  # 首页 banner
scripts/                # 主题自带脚本（会被复制到站点）
```

**关键点**：

- `archive.ejs` 里分类页按 `order` / `source` 排序（不是日期），这是为了和后台文件顺序一致
- `sidebar.ejs` 的同分类合集用 `catData.posts.toArray().sort(...)`
- `post.ejs` 在 `page.password` 时渲染 `.post-abstract`（加密文章的摘要）
- `post.ejs` 末尾是 giscus 评论区（`config.comments` 打开且 ID 齐全才渲染，加密文章不渲染）
- CSS 用 `:root` 变量 + `body.dark` 支持深浅色

### 评论（giscus）

评论用的是 [giscus](https://github.com/giscus/giscus)：数据存在仓库的 GitHub Discussions 里，纯前端 iframe，不需要任何服务器。

```
文章页 HTML（post.ejs）
  └─ <section class="post-comments" data-repo data-repo-id data-category-id ...>
       └─ <div class="giscus"></div>        ← giscus 把 iframe 塞进这里

/js/main.js
  └─ mountGiscus()   读 data-* → 动态插 <script src="https://giscus.app/client.js">
                     主题 auto 时按本站 body.dark 传 light / dark
  └─ syncGiscusTheme() 切深浅色时 postMessage 让 iframe 跟着换主题
```

**关键约定**：

- 配置写在**站点根目录** `_config.yml` 的 `comments` 段，不写在主题配置里。
  `安装博客园主题` 会整份覆盖 `themes/cnblog/_config.yml`，放那里的话 repoId 每装一次就没了。
- `enable: true` 且 `repo` / `repoId` / `categoryId` 都不为空才渲染，
  免得没配置时也去请求 giscus.app。
- `theme: auto` 表示跟随本站深浅色开关（本站默认跟随系统），也可以填
  `light` / `dark` / `dark_dimmed` / `preferred_color_scheme` 等 giscus 主题名。
- 加密文章（front-matter 有 `password`）不挂评论区：讨论会泄露标题和摘要。
- 单篇关评论：front-matter 写 `comments: false`。
- 后台「设置 → 评论（giscus）」用 `writeTopLevelBlock()` 只替换 `comments` 段，
  站点配置其余内容和注释原样保留；重复保存不会产生 diff。

### 浏览量（GoatCounter）

每篇文章的阅读数用 [GoatCounter](https://www.goatcounter.com)：无 Cookie、免费（非商业），计数存在它那边，页面只读一个 JSON。

```
layout.ejs
  └─ views.enable 时注入 <script data-goatcounter="https://<code>.goatcounter.com/count">
post.ejs
  └─ <span class="post-views" data-code data-label hidden>
main.js
  └─ fetch https://<code>.goatcounter.com/counter/<encodeURIComponent(pathname)>.json
     → { count: "1,234" } → 填「阅读 1,234」；失败保持隐藏
```

**关键约定**：

- 配置同样写在站点 `_config.yml` 的 `views` 段（不跟主题配置走，重装主题不会丢）：
  ```yaml
  views:
    enable: true
    code: yourcode   # GoatCounter 站点代码，即 https://yourcode.goatcounter.com
    label: 阅读
  ```
- `path` 固定用 `location.pathname`（同时写进 `window.goatcounter.path`），避免 `?giscus=` 这类查询串把同一篇文章拆成多个路径。
- 计数展示依赖 GoatCounter 站点设置里的 **Allow adding visitor counts on your website**（默认关闭）；
  没开时接口返回 404，页面保持隐藏，不影响正文。
- 计数接口缓存最多 4 小时；后台统计约 10 秒后可见。
- 广告拦截器可能拦 `gc.zgo.at`：被拦时只是不显示数字，不影响页面。


---

## 扩展指南

### 加一个新按钮

1. `index.html` 的 `.actions` 里加 `<button id="btnXxx">`
2. `app.js` 的 `bindEvents()` 里加 `$('#btnXxx').addEventListener('click', handler)`
3. 实现 `handler`
4. 改 `admin/index.html` 里的 `?v=N`（递增，防缓存）

### 加一个新的 front-matter 字段

1. `buildFrontMatter()` 里加输出
2. `splitFrontMatter()` 的结果在 `openPost()` 里映射到 `fillForm()`
3. `collectForm()` 里读取
4. 表单加输入框（`index.html`）
5. `docFingerprint()` 里加上（否则自动保存不触发）

### 改差异检测规则

只改 `local-store.js` 的 `computeStatus()`。所有调用方（`refreshDiffFromState`、`strictCompare`、`refreshLocalDiff`）都走它。

### 改主题

改 `themes/cnblog/` 下的文件，然后：

```powershell
node gen-theme-pack.cjs     # 重新生成 admin/theme-cnblog.js
```

否则 `安装博客园主题` 按钮装的是旧版。

### 加一个新的 GitHub 操作

用 `gh()`：

```js
await gh(`/repos/${owner}/${repo}/contents/${path}`, {
  method: 'PUT',
  body: JSON.stringify({ message, content: b64, sha }),
});
```

---

## 维护者须知

### 代码风格约定

- **中文注释**，解释"为什么"而不是"是什么"
- 函数名用英文，业务术语用中文（`movePostTo`、`分类`）
- 不用 TypeScript、不用框架、不用构建步骤
- 异步一律 `async/await`，不用 `.then()` 链（除少数被迫的地方）

### 坑（踩过的）

| 坑 | 说明 |
|---|---|
| **空仓库是 409 不是 404** | `GET /git/trees/{branch}` 对空仓库返回 409 `Git Repository is empty` |
| **trees 有延迟** | commit 后立刻拉 trees 可能拿不到新文件，要轮询 `waitForRemotePaths()` |
| **`.mjs` MIME** | 浏览器对 ES module 的 `.mjs` 严格校验 MIME，Python ≤3.11 不认。所以 `js-yaml.js` 用 `.js` 扩展名 |
| **PowerShell 5.1** | 不支持 `-Encoding utf8NoBOM`；`-replace` 替换串用单引号时 `` `n `` 不转义；双引号会展开 `$` |
| **start-admin.ps1 必须带 BOM** | 否则中文乱码 |
| **`relocateFile` 的 `fallbackContent`** | 曾经"优先读旧内容"导致新内容（改过的分类）被覆盖 |
| **`state.diff` 会被重算覆盖** | 手动 `set` 之后不能再调 `refreshDiffFromState()` |
| **`renderTreeNode` 里写死排序** | 曾经按文件名排，导致拖拽调序无效 |
| **`buildFrontMatter` 要求数组** | `categories`/`tags` 必须是数组，`toList()` 兜底 |
| **GitHub API 响应有 60 秒缓存** | 读到的 sha 可能是旧的，拿去写文件就是 409「文件冲突」。`gh()` 统一 `cache: 'no-store'`，评论设置保存还会自动重读重试 |
| **主题包路径必须带前缀** | 包里的键就是提交路径（`themes/cnblog/layout/post.ejs`）。生成脚本的基准目录若写成 `themes/cnblog`，键会变成 `layout/post.ejs`，装主题时会写到仓库根目录、把站点 `_config.yml` 覆盖成主题配置。生成器已改用仓库根作基准，`installCnblogTheme` 也会拒绝无前缀的包 |
| **构建成功但页面全 404** | `package.json` 缺 `markdown-it-task-lists` 时 `hexo-renderer-markdown-it` 加载失败，Hexo 只复制静态资源、不生成任何 HTML，Actions 却仍显示成功。装主题时会自动把缺失依赖补进 `package.json` |

### 测试

`vendor-src/e2e.mjs` 是 Puppeteer 端到端测试（90 项）。

```powershell
# 起一个静态服务器
python -m http.server 8765 --directory ..\admin

# 改 e2e.mjs 里的 URL 端口，然后跑
node e2e.mjs
```

覆盖：编辑器初始化、front-matter 往返、公式渲染、代码高亮、自动保存、图片识别、导入、设置面板、连接测试、列表渲染、搜索、URL 推断。

### 版本号

`admin/index.html` 里的 `?v=N` 用来破缓存。**每次改 `app.js` / `style.css` / `theme-cnblog.js` 都要递增**。

当前：`v=78`。

### 打包

```powershell
# 1. 生成主题包（如果改了主题）
node gen-theme-pack.cjs

# 2. 递增版本号

# 3. 复制到 dist
Copy-Item admin dist\blog-admin-kit\admin -Recurse -Force

# 4. 压缩
Compress-Archive -Path dist\blog-admin-kit\* -DestinationPath dist\blog-admin-kit.zip -Force
```

### 安全

- Token 存在 `localStorage`，**不上传任何服务器**
- 后台只跑在 `127.0.0.1`，外网访问不到
- 不要在代码里硬编码 token
- `fetch` 都不带 `credentials`，避免跨站带 cookie

### 已知限制

1. 单文件上传（`putFile`）没有重试，网络抖动会失败
2. 多文件提交（`commitFiles`）用的是 Git Trees API，大文件（>100MB）不支持
3. 主题包是生成物，手改 `admin/theme-cnblog.js` 会被覆盖
4. 不支持 Git LFS
5. 多人同时编辑会冲突（没有 merge 逻辑，后提交的覆盖）

### 交接建议

如果要把这个项目继续做大，可以考虑：

1. **抽出 API 层** —— `gh()` 相关逻辑抽成 `github-api.js`，目前混在 `app.js` 里
2. **拆 `app.js`** —— 已经 5000 行，可以按 `editor.js` / `posts.js` / `settings.js` / `theme-install.js` 拆
3. **加重试** —— `putFile` / `commitFiles` 网络失败时自动重试
4. **加冲突处理** —— 上传前检查远程 sha 是否变了
5. **PWA 化** —— 加 Service Worker，离线也能用

---

## 致谢

- [Hexo](https://hexo.io/) —— 静态博客框架
- [markdown-it](https://github.com/markdown-it/markdown-it) —— Markdown 渲染
- [KaTeX](https://katex.org/) —— 数学公式
- [EasyMDE](https://github.com/Ionaru/easy-markdown-editor) —— 编辑器
- [JSZip](https://stuk.github.io/jszip/) —— 打包
