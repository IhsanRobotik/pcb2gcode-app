const { readFileSync, writeFileSync, copyFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const iconPackage = resolve(root, 'node_modules/bootstrap-icons');
const icons = new Set(['github', 'envelope', 'linkedin', 'sun-fill', 'moon-stars-fill', 'people-fill', 'arrow-clockwise', 'book', 'arrow-left', 'search', 'list', 'upload']);
for (const file of ['index.html', 'wiki.html']) {
const htmlPath = resolve(root, file);
const html = readFileSync(htmlPath, 'utf8').replace(
  /(<(a|span)\b[^>]*data-(?:contact|ui)-icon="([^"]+)"[^>]*>)[\s\S]*?(<\/\2>)/g,
  (_, open, tag, icon, close) => {
    if (!icons.has(icon)) throw new Error(`Unknown UI icon: ${icon}`);
    const svg = readFileSync(resolve(iconPackage, 'icons', `${icon}.svg`), 'utf8')
      .trim().replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
    return `${open}${svg}${close}`;
  },
);
writeFileSync(htmlPath, html);
}
copyFileSync(resolve(iconPackage, 'LICENSE'), resolve(root, 'vendor/bootstrap-icons-LICENSE'));
console.log('Embedded Bootstrap Icons: navigation, contacts, theme controls, visitor counter and uploads.');
