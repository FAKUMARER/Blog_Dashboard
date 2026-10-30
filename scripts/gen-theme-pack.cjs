/**
 * 把 themes/cnblog/ 打包成 admin/theme-cnblog.js
 * 改了主题之后必须重新跑一次，否则后台「安装博客园主题」装的是旧版。
 *
 * 用法：node scripts/gen-theme-pack.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const THEME_DIR = path.join(ROOT, 'themes', 'cnblog');
const OUT_FILE = path.join(ROOT, 'admin', 'theme-cnblog.js');

const files = {};
const assets = {};

function walk(dir, base) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      walk(full, base);
      continue;
    }
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (/\.(woff2?|webp|png|jpe?g|gif|ico|svg)$/i.test(name)) {
      assets[rel] = fs.readFileSync(full).toString('base64');
    } else {
      files[rel] = fs.readFileSync(full, 'utf8');
    }
  }
}

if (!fs.existsSync(THEME_DIR)) {
  console.error(`主题目录不存在：${THEME_DIR}`);
  process.exit(1);
}

// 基准目录必须是仓库根，不是 themes/cnblog：
// 包里的键就是提交路径（themes/cnblog/layout/post.ejs），
// 后台「安装主题」直接拿键当 path 用，少一层前缀就会写到仓库根目录。
walk(THEME_DIR, ROOT);

const banner = '// 由 scripts/gen-theme-pack.cjs 自动生成，请勿手改\n';
fs.writeFileSync(
  OUT_FILE,
  `${banner}window.CNBLOG_THEME = ${JSON.stringify({ files, assets }, null, 2)};\n`,
  'utf8',
);

console.log(`打包完成：${Object.keys(files).length} 个文本 + ${Object.keys(assets).length} 个资源`);
console.log(`输出：${OUT_FILE}`);
