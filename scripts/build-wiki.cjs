const { copyFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
const output = resolve(root, 'vendor/wiki-runtime');
mkdirSync(output, { recursive: true });
for (const [from, to] of [
  ['marked/lib/marked.esm.js', 'marked.js'],
  ['marked/LICENSE', 'marked-LICENSE'],
  ['dompurify/dist/purify.es.mjs', 'purify.js'],
  ['dompurify/LICENSE', 'DOMPurify-LICENSE'],
]) copyFileSync(resolve(root, 'node_modules', from), resolve(output, to));
console.log('Prepared local Markdown renderer and HTML sanitizer.');
