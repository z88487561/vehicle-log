// 把網頁需要的檔案複製到 www/，給 Capacitor 打包進 APK。
// 刻意不複製 sw.js（APK 內資源已在本機，不需要 Service Worker）、README 與建置相關檔案。
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const files = ['index.html', 'styles.css', 'core.js', 'scan.js', 'jsQR.js', 'backup.js', 'app.js', 'manifest.webmanifest', 'icon.svg'];
const dirs = ['icons'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of files) {
  if (!existsSync(join(root, f))) throw new Error('缺少檔案：' + f);
  cpSync(join(root, f), join(out, f));
}
for (const d of dirs) cpSync(join(root, d), join(out, d), { recursive: true });

// Capacitor 網頁端執行程式（提供 registerPlugin）。只放進 www/，網頁版（GitHub Pages）的 index.html 不受影響。
const core = join(root, 'node_modules/@capacitor/core/dist/capacitor.js');
if (!existsSync(core)) throw new Error('找不到 @capacitor/core，請先執行 npm ci');
cpSync(core, join(out, 'capacitor.js'));
const html = readFileSync(join(out, 'index.html'), 'utf8');
if (!html.includes('<head>')) throw new Error('index.html 找不到 <head>');
writeFileSync(join(out, 'index.html'), html.replace('<head>', '<head>\n<script src="capacitor.js"></script>'));
console.log('www/ 已更新：' + [...files, ...dirs.map(d => d + '/'), 'capacitor.js'].join(', '));
