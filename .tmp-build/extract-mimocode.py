"""Digest all MiMoCode sessions of the prism-agent project into readable text."""
import sqlite3, json, pathlib, datetime, re, sys, collections

DB = r'C:\Users\chenfei\.local\share\mimocode\mimocode.db'
PID = '5b1abac6-39d3-43a7-b399-c9990c79463a'
OUT = pathlib.Path(__file__).resolve().parent / 'digests-mimo'

TEXT_CAP = 3500
TOOL_CAP = 700
REASONING_CAP = 200


def fmt(ts):
    try:
        return datetime.datetime.fromtimestamp(ts / 1000).strftime('%y-%m-%d %H:%M')
    except Exception:
        return '?'


def clean(s, cap):
    s = re.sub(r'\s+', ' ', str(s)).strip()
    return s[:cap] + (f' …(+{len(s) - cap})' if len(s) > cap else '')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=20)
    sessions = con.execute(
        "SELECT id, parent_id, directory, title, time_created, time_updated FROM session "
        "WHERE project_id=? ORDER BY time_created", (PID,)).fetchall()
    sids = [r[0] for r in sessions]
    meta = {r[0]: r for r in sessions}
    by_sid = collections.defaultdict(list)

    cur = con.execute(
        "SELECT session_id, time_created, data FROM part WHERE session_id IN (%s) ORDER BY time_created"
        % ','.join('?' * len(sids)), sids)
    for sid, ts, raw in cur:
        by_sid[sid].append((ts, raw))

    index = []
    order = 0
    for sid, parent, directory, title, t_created, t_updated in sessions:
        parts = by_sid.get(sid)
        if not parts:
            continue
        order += 1
        name = f'{order:04d}_{fmt(t_created).replace(" ", "_").replace(":", "")}_{(sid[4:16])}.txt'
        lines = [
            f'# MiMoCode session {sid}',
            f'title: {title!r}  parent: {bool(parent)}  dir: {directory}',
            f'span: {fmt(t_created)} — {fmt(t_updated)}  parts: {len(parts)}',
            '',
        ]
        for ts, raw in parts:
            try:
                d = json.loads(raw)
            except Exception:
                continue
            t = d.get('type')
            ts_s = fmt(ts)[2:14]
            if t == 'text':
                text = d.get('text', '')
                sys_flag = ' SYS' if d.get('system') else ''
                lines.append(f'[{ts_s}] TEXT{sys_flag}: {clean(text, TEXT_CAP)}')
            elif t == 'reasoning':
                lines.append(f'[{ts_s}] (think): {clean(d.get("text", ""), REASONING_CAP)}')
            elif t == 'tool':
                tool = d.get('tool', '?')
                st = d.get('state', {}) or {}
                inp = st.get('input', {}) or {}
                args = json.dumps(inp, ensure_ascii=False) if not isinstance(inp, str) else inp
                outp = str(st.get('output', ''))[:TOOL_CAP]
                lines.append(f'[{ts_s}] TOOL {tool}: {clean(args, TOOL_CAP)}')
                lines.append(f'           OUT: {clean(outp, 300)}')
            elif t == 'step-start' or t == 'step-finish':
                continue
            elif t == 'agent':
                lines.append(f'[{ts_s}] SUBAGENT: {d.get("name", "")}')
            else:
                h = json.dumps(d, ensure_ascii=False)
                if len(h) > 80:
                    lines.append(f'[{ts_s}] {t}: {clean(h, 220)}')
        (OUT / name).write_text('\n'.join(lines), encoding='utf-8')
        index.append(f'{name}  parts={len(parts)}  {fmt(t_created)}  {(title or "")[:60]}')

    (OUT / '_index.txt').write_text('\n'.join(index), encoding='utf-8')
    print('sessions digested:', order, '->', OUT)


if __name__ == '__main__':
    main()
