"""Read a local Markdown wiki without exposing repository internals."""
import re
from pathlib import Path, PurePosixPath

TITLES = {
    'Home': 'Overview', 'Options:-Milling': 'Milling',
    'Options:-Drilling': 'Drilling', 'Options:-Outline': 'Board outline',
    'Options:-Alignment-for-two-sided-PCB-and-offsets': 'Two-sided alignment',
    'Options:-Common': 'Machine settings', 'Options:-Optimizations': 'Optimization',
    'Options:-Generic': 'General options', 'Manual': 'Legacy manual',
}
ORDER = {name: index for index, name in enumerate(TITLES)}
IMAGE_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml'}


def wiki_file(root, relative):
    root = Path(root).resolve()
    name = PurePosixPath(relative)
    if name.is_absolute() or not name.parts or any(part.startswith('.') for part in name.parts):
        raise ValueError('Invalid wiki path.')
    path = (root / str(name)).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError('Wiki file not found.')
    return path


def wiki_pages(root):
    root = Path(root).resolve()
    if not root.is_dir():
        return []
    result = []
    total = 0
    for candidate in root.rglob('*'):
        if candidate.suffix.lower() not in {'.md', '.markdown'} or candidate.stem.startswith('_'):
            continue
        try:
            path = wiki_file(root, candidate.relative_to(root).as_posix())
        except (OSError, ValueError):
            continue
        if path.stat().st_size > 2 * 1024 * 1024:
            continue
        content = path.read_text(encoding='utf-8-sig')
        total += len(content.encode('utf-8'))
        if total > 20 * 1024 * 1024:
            raise ValueError('Wiki exceeds the supported size.')
        page_id = candidate.relative_to(root).with_suffix('').as_posix()
        heading = re.search(r'^#\s+(.+?)\s*#*\s*$', content, re.M)
        title = TITLES.get(page_id, heading[1].replace('`', '') if heading else candidate.stem.replace('-', ' '))
        paragraphs = [line.strip() for line in content.splitlines() if line.strip() and not line.startswith(('#', '```', '    ', '|'))]
        summary = re.sub(r'\[([^]]+)\]\([^)]+\)', r'\1', paragraphs[0] if paragraphs else '')
        summary = re.sub(r'[*_`]', '', summary)
        if len(summary) > 160:
            summary = summary[:157].rsplit(' ', 1)[0] + '…'
        result.append({'id': page_id, 'title': title, 'summary': summary, 'content': content, 'legacy': page_id == 'Manual'})
    return sorted(result, key=lambda page: (ORDER.get(page['id'], len(ORDER)), page['title'].casefold()))
