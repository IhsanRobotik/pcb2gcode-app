import { marked } from '/wiki-runtime/marked.js';
import DOMPurify from '/wiki-runtime/purify.js';

const $ = (selector) => document.querySelector(selector);
const article = $('#wikiArticle');
const search = $('#wikiSearch');
let pages = [];
let currentPage = null;
let sectionObserver;

const browserTheme = matchMedia('(prefers-color-scheme: dark)');
let themeChoice = localStorage.getItem('toolpath-theme');
function applyTheme() {
  const light = themeChoice === 'light' || (themeChoice !== 'dark' && !browserTheme.matches);
  document.body.classList.toggle('light', light);
  const action = light ? 'Switch to dark mode' : 'Switch to light mode';
  $('#wikiThemeButton').setAttribute('aria-label', action);
  $('#wikiThemeButton').title = action;
  $('meta[name="theme-color"]').content = light ? '#f2f4f0' : '#101211';
}
applyTheme();
$('#wikiThemeButton').addEventListener('click', () => {
  themeChoice = document.body.classList.contains('light') ? 'dark' : 'light';
  localStorage.setItem('toolpath-theme', themeChoice);
  applyTheme();
});
browserTheme.addEventListener('change', applyTheme);
window.addEventListener('storage', (event) => {
  if (event.key === 'toolpath-theme') { themeChoice = event.newValue; applyTheme(); }
});

function pageURL(id, hash = '') {
  const url = new URL('/wiki/', location.origin);
  url.searchParams.set('page', id);
  url.hash = hash;
  return url.pathname + url.search + url.hash;
}
function key(value) {
  return value.replace(/\.(?:md|markdown)$/i, '').replace(/[ _]/g, '-').toLowerCase();
}
function linkedPage(href) {
  try {
    const url = new URL(href, location.href);
    let name;
    if (url.origin === location.origin && url.pathname.replace(/\/$/, '') === '/wiki') name = url.searchParams.get('page') || 'Home';
    else if (url.hostname === 'github.com' && url.pathname.startsWith('/pcb2gcode/pcb2gcode/wiki/')) name = decodeURIComponent(url.pathname.split('/wiki/')[1]);
    else if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('#')) {
      const directory = currentPage?.id.includes('/') ? currentPage.id.slice(0, currentPage.id.lastIndexOf('/') + 1) : '';
      name = directory + decodeURIComponent(href.split(/[?#]/)[0]);
    }
    const page = name && pages.find((item) => key(item.id) === key(name));
    return page ? { page, hash: url.hash } : null;
  } catch { return null; }
}
function renderNavigation() {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = pages.filter((page) => terms.every((term) => `${page.title}\n${page.content}`.toLowerCase().includes(term)));
  const list = $('#wikiPageList');
  list.replaceChildren();
  for (const page of matches) {
    const link = document.createElement('a');
    link.href = pageURL(page.id);
    link.textContent = page.title;
    if (page.id === currentPage?.id) link.setAttribute('aria-current', 'page');
    list.append(link);
  }
  $('#wikiSearchStatus').textContent = terms.length ? `${matches.length} matching page${matches.length === 1 ? '' : 's'}` : `${pages.length} reference pages`;
  if (!matches.length) {
    const empty = document.createElement('p'); empty.className = 'wiki-search-empty'; empty.textContent = 'No matching pages. Try a topic or an option such as --zsafe.'; list.append(empty);
  }
}
function setMenu(open) {
  document.body.classList.toggle('wiki-nav-open', open);
  $('#wikiNavToggle').setAttribute('aria-expanded', String(open));
  if (open) search.focus();
}
$('#wikiNavToggle').addEventListener('click', () => setMenu(!document.body.classList.contains('wiki-nav-open')));
search.addEventListener('input', renderNavigation);
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.target.matches('input,textarea')) {
    event.preventDefault(); if (matchMedia('(max-width: 900px)').matches) setMenu(true); search.focus();
  }
  if (event.key === 'Escape') { search.value = ''; renderNavigation(); setMenu(false); }
});
function slug(text) {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().replace(/\s+/g, '-') || 'section';
}
function scrollToHash() {
  if (!location.hash) return;
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const target = [...article.querySelectorAll('[id], [name]')].find((element) => element.id === id || element.getAttribute('name') === id);
  target?.scrollIntoView({ block: 'start' });
}
function imageSource(src) {
  try {
    const url = new URL(src, location.href);
    const github = url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/blob\//.test(url.pathname);
    if (github) return `https://raw.githubusercontent.com${url.pathname.replace('/blob/', '/')}`;
    if (/^(?:https?:|data:)/i.test(src) || src.startsWith('//')) return url.href;
    const local = new URL(src, new URL(currentPage.id + '.md', 'https://wiki.local/'));
    return '/api/wiki/asset?path=' + encodeURIComponent(decodeURIComponent(local.pathname.slice(1)));
  } catch { return ''; }
}
function enhanceArticle() {
  const used = new Map();
  const sections = $('#wikiSections');
  sections.replaceChildren();
  sectionObserver?.disconnect();
  for (const heading of article.querySelectorAll('h1,h2,h3,h4')) {
    const title = heading.textContent.trim();
    const base = slug(title), count = used.get(base) || 0;
    used.set(base, count + 1);
    heading.id = base + (count ? `-${count}` : '');
    const anchor = document.createElement('a'); anchor.className = 'wiki-heading-link'; anchor.href = '#' + heading.id; anchor.textContent = '#'; anchor.setAttribute('aria-label', `Link to ${title}`); heading.append(anchor);
    if (heading.matches('h2,h3')) {
      const link = document.createElement('a'); link.href = '#' + heading.id; link.textContent = title; link.dataset.heading = heading.id; if (heading.matches('h3')) link.className = 'wiki-subsection'; sections.append(link);
    }
  }
  if (!sections.childElementCount) {
    const text = document.createElement('p'); text.textContent = 'Choose a topic to explore its options.'; text.className = 'wiki-outline-empty'; sections.append(text);
  }
  sectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of sections.querySelectorAll('a')) {
        if (link.dataset.heading === entry.target.id) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }
  }, { rootMargin: '-90px 0px -65% 0px' });
  article.querySelectorAll('h2,h3').forEach((heading) => sectionObserver.observe(heading));
  for (const link of article.querySelectorAll('a[href]')) {
    const destination = linkedPage(link.getAttribute('href'));
    if (destination) link.href = pageURL(destination.page.id, destination.hash);
    else if (/^https?:/i.test(link.href) && new URL(link.href).origin !== location.origin) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
  for (const image of article.querySelectorAll('img')) {
    image.src = imageSource(image.getAttribute('src'));
    image.loading = 'lazy'; image.decoding = 'async';
    image.addEventListener('error', () => {
      const fallback = document.createElement('a'); fallback.className = 'wiki-image-fallback'; fallback.href = image.src; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer'; fallback.textContent = image.alt ? `Open illustration: ${image.alt}` : 'Open illustration'; image.replaceWith(fallback);
    }, { once: true });
  }
  for (const pre of article.querySelectorAll('pre')) {
    const code = pre.querySelector('code'); if (!code) continue;
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'wiki-copy'; copy.textContent = 'Copy'; copy.setAttribute('aria-label', 'Copy code block');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code.textContent); copy.textContent = 'Copied'; }
      catch { const range = document.createRange(); range.selectNodeContents(code); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); copy.textContent = 'Selected'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    });
    pre.append(copy);
  }
}
function renderCards() {
  const grid = document.createElement('div'); grid.className = 'wiki-topic-grid';
  for (const page of pages.filter((item) => item.id !== currentPage.id && !item.legacy)) {
    const link = document.createElement('a'); link.href = pageURL(page.id);
    const title = document.createElement('strong'); title.textContent = page.title;
    const summary = document.createElement('span'); summary.textContent = page.summary;
    link.append(title, summary); grid.append(link);
  }
  article.append(grid);
}
function renderFooter(page) {
  const footer = $('#wikiPageFooter'); footer.replaceChildren();
  const index = pages.indexOf(page);
  for (const [other, label] of [[pages[index - 1], 'Previous page'], [pages[index + 1], 'Next page']]) {
    if (!other) { footer.append(document.createElement('span')); continue; }
    const link = document.createElement('a'); link.href = pageURL(other.id);
    const small = document.createElement('small'); small.textContent = label;
    const title = document.createElement('strong'); title.textContent = other.title;
    link.append(small, title); footer.append(link);
  }
}
function showPage(id, push = false, hash = '') {
  const page = pages.find((item) => item.id === id);
  if (push) history.pushState({}, '', pageURL(id, hash));
  if (!page) {
    currentPage = null; article.replaceChildren();
    const heading = document.createElement('h1'); heading.textContent = 'Page not found';
    const text = document.createElement('p'); text.textContent = 'Choose a page from the documentation list.';
    article.append(heading, text); $('#wikiSections').replaceChildren(); $('#wikiPageFooter').replaceChildren(); renderNavigation(); article.setAttribute('aria-busy', 'false'); return;
  }
  currentPage = page;
  document.title = `${page.title} · PCB2gcode documentation`;
  const markdown = page.content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, label, target) => `[${label}](${encodeURI(target || label)})`);
  article.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { gfm: true, breaks: false }), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'], FORBID_ATTR: ['style'] });
  if (page.legacy && article.querySelector('h1')?.textContent.toLowerCase().includes('obsolete')) {
    const old = article.querySelector('h1'); const note = document.createElement('aside'); note.className = 'wiki-legacy-notice'; note.textContent = old.textContent; old.replaceWith(note);
  }
  if (!article.querySelector('h1')) {
    const heading = document.createElement('h1'); heading.textContent = page.id === 'Home' ? 'pcb2gcode documentation' : page.title; article.prepend(heading);
  }
  if (page.id === 'Home') {
    for (const paragraph of article.querySelectorAll('p')) {
      if (paragraph.textContent.trim() === 'Check the sidebar on the right to learn about more topics.') paragraph.textContent = 'Browse the topics below, or search the reference pages.';
    }
    renderCards();
  }
  enhanceArticle(); renderNavigation(); renderFooter(page); setMenu(false);
  article.setAttribute('aria-busy', 'false');
  if (location.hash) requestAnimationFrame(scrollToHash); else window.scrollTo(0, 0);
}
document.addEventListener('click', (event) => {
  if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest('a[href]'); if (!link || link.target === '_blank' || link.getAttribute('href').startsWith('#')) return;
  const destination = linkedPage(link.getAttribute('href'));
  if (!destination) return;
  event.preventDefault(); showPage(destination.page.id, true, destination.hash);
});
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('page') || pages.find((page) => page.id === 'Home')?.id || pages[0]?.id;
  if (id === currentPage?.id) scrollToHash(); else showPage(id);
});
try {
  const response = await fetch('/api/wiki', { cache: 'no-store' });
  if (!response.ok) throw new Error('Documentation could not be loaded.');
  const result = await response.json();
  if (!Array.isArray(result.pages) || !result.pages.length) throw new Error('No wiki pages are available yet.');
  pages = result.pages;
  const id = new URLSearchParams(location.search).get('page') || pages.find((page) => page.id === 'Home')?.id || pages[0].id;
  showPage(id);
} catch (error) {
  article.replaceChildren();
  const heading = document.createElement('h1'); heading.textContent = 'Documentation unavailable';
  const text = document.createElement('p'); text.textContent = error.message;
  article.append(heading, text); article.setAttribute('aria-busy', 'false');
  $('#wikiSearchStatus').textContent = 'No pages available';
}
