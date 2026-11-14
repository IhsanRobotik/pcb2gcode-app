"""Discover downloadable PCB example sets without a hard-coded file list."""
import json
import re
from pathlib import Path, PurePosixPath
from urllib.parse import quote

GERBERS = {'.gbr', '.ger', '.gerber', '.pho', '.gtl', '.gbl', '.gm1', '.gko'}
DRILLS = {'.drl', '.xln', '.txt', '.tap'}
JOBS = {'.gbrjob', '.json'}
SUFFIX = re.compile(r'^(.*?)(?:[-_. ]+)?(F[-_. ]?Cu|B[-_. ]?Cu|Edge[-_. ]?Cuts|NPTH|PTH|front|back|top|bottom|outline|profile|drill|job)$', re.I)
ROLE_NAMES = {'fcu': 'front', 'front': 'front', 'top': 'front', 'bcu': 'back', 'back': 'back', 'bottom': 'back', 'edgecuts': 'outline', 'outline': 'outline', 'profile': 'outline', 'npth': 'npth', 'pth': 'drill', 'drill': 'drill', 'job': 'job'}
ROLE_ORDER = {'front': 0, 'back': 1, 'outline': 2, 'drill': 3, 'npth': 4, 'job': 5}


def resolve_example_file(root, relative):
    root = Path(root).resolve()
    name = PurePosixPath(relative)
    if name.is_absolute() or any(part.startswith('.') for part in name.parts):
        raise ValueError('Invalid example path.')
    path = (root / str(name)).resolve()
    if not path.is_relative_to(root) or path.suffix.lower() not in GERBERS | DRILLS | JOBS:
        raise ValueError('Invalid example path.')
    if not path.is_file():
        raise FileNotFoundError('Example file not found.')
    return path


def role_from_function(function):
    function = function.lower()
    if function.startswith('copper,'):
        if re.search(r',(?:top|front)(?:,|$)', function):
            return 'front'
        if re.search(r',(?:bot|bottom|back)(?:,|$)', function):
            return 'back'
    if function.startswith(('profile', 'outline')):
        return 'outline'
    if function.startswith(('nonplated', 'non-plated')):
        return 'npth'
    if function.startswith(('plated', 'drill')):
        return 'drill'
    return None


def filename_info(path):
    match = SUFFIX.match(path.stem)
    if match:
        prefix, suffix = match.groups()
        return prefix.rstrip('-_. ') or path.parent.name, ROLE_NAMES[re.sub(r'[-_. ]', '', suffix.lower())]
    return path.stem, None


def read_job(path):
    if path.stat().st_size > 4 * 1024 * 1024:
        return None
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        return data if isinstance(data, dict) and ('GeneralSpecs' in data or 'FilesAttributes' in data) else None
    except (OSError, UnicodeError, ValueError):
        return None


def discover_examples(root):
    root = Path(root).resolve()
    if not root.is_dir():
        return []
    paths = []
    for candidate in sorted(root.rglob('*'), key=lambda p: p.as_posix().casefold()):
        try:
            resolve_example_file(root, candidate.relative_to(root).as_posix())
        except (OSError, ValueError):
            continue
        paths.append(candidate)
    # A KiCad job gives reliable roles and grouping even for arbitrary filenames.
    assignments = {}
    jobs = {}
    for path in paths:
        if path.suffix.lower() not in JOBS:
            continue
        data = read_job(path)
        if data is None:
            continue
        jobs[path] = data
        prefix, _ = filename_info(path)
        group = (path.parent, prefix)
        assignments[path] = (group, 'job')
        attributes = data.get('FilesAttributes', [])
        if not isinstance(attributes, list):
            continue
        for item in attributes:
            if not isinstance(item, dict) or not isinstance(item.get('Path'), str):
                continue
            candidate = path.parent / item['Path']
            try:
                target = resolve_example_file(root, candidate.relative_to(root).as_posix())
            except (OSError, ValueError):
                continue
            function = item.get('FileFunction', '')
            role = role_from_function(function) if isinstance(function, str) else None
            assignments[target] = (group, role)
    groups = {}
    for path in paths:
        prefix, role = filename_info(path)
        group = (path.parent, prefix)
        if path in assignments:
            group, role = assignments[path]
        elif path.suffix.lower() in JOBS:
            continue
        else:
            with path.open('rb') as source:
                header = source.read(65536).decode('latin-1')
            function = re.search(r'%TF\.FileFunction,([^*]+)\*%', header, re.I)
            if function:
                role = role_from_function(function[1])
            elif path.suffix.lower() in {'.gtl', '.gbl', '.gm1', '.gko'}:
                role = {'.gtl': 'front', '.gbl': 'back', '.gm1': 'outline', '.gko': 'outline'}[path.suffix.lower()]
            elif path.suffix.lower() in DRILLS and role not in {'drill', 'npth'}:
                role = 'drill'
        if role is None or (role == 'job' and path not in jobs):
            continue
        directory, board = group
        relative = path.relative_to(root).as_posix()
        group_id = (directory.relative_to(root) / board).as_posix()
        entry = groups.setdefault(group_id, {'id': group_id, 'name': group_id, 'files': []})
        entry['files'].append({'name': path.name, 'path': relative, 'role': role, 'size': path.stat().st_size, 'url': '/api/examples/file?path=' + quote(relative, safe='')})
    result = []
    for entry in groups.values():
        if any(file['role'] != 'job' for file in entry['files']):
            entry['files'].sort(key=lambda file: (ROLE_ORDER[file['role']], file['name'].casefold()))
            result.append(entry)
    return sorted(result, key=lambda entry: entry['name'].casefold())
