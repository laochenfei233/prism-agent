"""Inventory ~/.codex/sessions rollouts by cwd and opening user text."""
import json, pathlib, collections

root = pathlib.Path.home() / '.codex' / 'sessions'
rows = []
for f in root.rglob('*.jsonl'):
    cwd = '?'
    first_user = ''
    try:
        with open(f, encoding='utf-8', errors='replace') as fh:
            for i, line in enumerate(fh):
                if i > 8:
                    break
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                p = d.get('payload', {})
                if p.get('cwd'):
                    cwd = p['cwd']
                t = p.get('type') if isinstance(p, dict) else None
                # user message payloads may carry the first instruction text
                if not first_user:
                    content = p.get('message') or ''
                    if isinstance(content, str) and content.strip():
                        first_user = content.strip()[:150]
    except Exception as e:
        cwd = f'ERR {str(e)[:60]}'
    rows.append((f.stat().st_size, str(f), cwd, first_user.replace('\n', ' ')))

groups = collections.Counter()
for _, _, cwd, _ in rows:
    norm = cwd.replace('/', ' ').split('\\')
    key = norm[-1] if norm[-1] else norm[-2] if len(norm) > 1 else cwd
    groups[key] += 1
print('== sessions per working dir ==')
for k, c in groups.most_common(50):
    print(f'{c:3d}  {k}')
total_mb = sum(s for s, _, _, _ in rows) / 1e6
print('== total files:', len(rows), ' total MB:', round(total_mb, 1))
print()
print('== per-file detail (MB, name, cwd tail) ==')
for s, path, cwd, _ in sorted(rows):
    mb = round(s / 1e6, 2)
    tail = path.split('sessions')[-1][1:].replace('\\', '/')
    print(f'{mb:7.2f}  {tail}   {cwd[-60:]}')
