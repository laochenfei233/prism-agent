"""Digest codex rollout JSONL files into readable text under .tmp-build/digests/."""
import json, pathlib, re, sys, shutil

ROOT = pathlib.Path.home() / '.codex' / 'sessions'
OUT = pathlib.Path(__file__).resolve().parent / 'digests'
TARGET = pathlib.Path('C:/Users/chenfei/Documents/GitHub/prism-agent')

TRUNC = 600          # max chars for tool-ish payloads
MSG_TRUNC = 4000     # max chars per assistant/user message kept in full


def decode_text(content):
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for c in content:
            if isinstance(c, dict):
                t = c.get('text') or c.get('content') or ''
                typ = c.get('type', '')
                if isinstance(t, str):
                    parts.append(t if typ in ('input_text', 'output_text', 'output', 'text') else f'[{typ}] {t}')
    return '\n'.join(parts)


def digest_file(path, out):
    lines = []
    try:
        with open(path, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                ts = (d.get('timestamp') or '')[11:19].replace('/', ':')
                typ = d.get('type', '?')
                p = d.get('payload', {}) if isinstance(d.get('payload'), dict) else {}
                ptype = p.get('type', '')
                if typ == 'session_meta':
                    cwd = p.get('cwd', '?')
                    cli = p.get('cli_version', '?')
                    lines.append(f'### session_meta cwd={cwd} cli={cli}')
                elif typ == 'turn_context':
                    cw = p.get('cwd', '')
                    m = p.get('model', '?')
                    eff = p.get('effort', '') or ''
                    lines.append(f'--- turn_context model={m} {eff} cwd={cw[-50:]}')
                elif ptype in ('message',):
                    role = p.get('role', '?')
                    text = decode_text(p.get('content', []))
                    text = text.strip()
                    if not text:
                        continue
                    tag = {'assistant': 'ASSISTANT', 'user': 'USER'}.get(role, role.upper())
                    # user turn messages carry environment_context wrappers; keep anything with real content
                    if tag == 'USER' and text.startswith('<'):
                        # environment context / user_instructions blocks: show first line only
                        head = text[:300]
                        lines.append(f'[{ts}] {tag}(env/instructions): {head}')
                        continue
                    lines.append(f'[{ts}] {tag}: {text[:MSG_TRUNC]}')
                    if len(text) > MSG_TRUNC:
                        lines.append(f'   …(+{len(text) - MSG_TRUNC} chars)')
                elif ptype == 'reasoning':
                    text = decode_text(p.get('summary', []))[:300]
                    if text:
                        lines.append(f'[{ts}] (reasoning) {text}')
                elif ptype in ('function_call', 'custom_tool_call', 'local_shell_call'):
                    name = p.get('name', 'shell')
                    args = p.get('arguments') or p.get('input') or ''
                    try:
                        a = json.loads(args) if isinstance(args, str) else args
                        cmd = a.get('command') if isinstance(a, dict) else None
                        if isinstance(cmd, list):
                            args = ' '.join(str(c) for c in cmd)
                        elif a and not isinstance(a, str):
                            args = json.dumps(a, ensure_ascii=False)[:TRUNC]
                        else:
                            args = str(a)
                    except Exception:
                        pass
                    args = re.sub(r'\s+', ' ', str(args))[:TRUNC]
                    lines.append(f'[{ts}] CALL {name}: {args}')
                elif ptype in ('function_call_output', 'custom_tool_call_output', 'local_shell_call_output'):
                    outp = decode_text(p.get('output', ''))
                    lines.append(f'[{ts}] OUT: {re.sub(chr(10), " ", outp)[:TRUNC]}')
                elif ptype in ('agent_message', 'user_message'):
                    text = str(p.get('message', ''))[:MSG_TRUNC]
                    lines.append(f'[{ts}] {ptype.upper()}: {text}')
                elif ptype in ('exec_commandBEGIN'.lower(), 'exec_command_begin'):
                    cmd = ' '.join(str(x) for x in p.get('command', []) if isinstance(x, (str, int)))
                    lines.append(f'[{ts}] EXEC: {cmd[:TRUNC]}')
                elif ptype == 'token_count':
                    continue
                elif ptype in ('turn_aborted', 'task_started', 'task_complete', 'agent_reasoning_delta',
                               'agent_message_delta', 'agent_reasoning', 'agent_reasoning_section_break', 'exec_command_end'):
                    continue
                else:
                    h = json.dumps(p, ensure_ascii=False)[:TRUNC]
                    if h and h != '{}':
                        lines.append(f'[{ts}] {typ}/{ptype or "raw"}: {h}')
    except Exception as e:
        lines.append(f'!! extractor error: {e}')
    if not lines:
        lines = ['(empty digest)']
    out.write_text('\n'.join(lines), encoding='utf-8')


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    only = sys.argv[1:] if len(sys.argv) > 1 else None
    files = sorted(ROOT.rglob('*.jsonl'))
    for f in files:
        # cwd filter via session_meta happens per file content; filter after parse by path:
        # sessions cwd'd at prism-agent; cheap check on first KB
        head = open(f, 'rb').read(4096).decode('utf-8', 'replace')
        if not re.search(r'GitHub[\\/]prism-agent(?!-)', head):
            # some later turn_context lines carry cwd; full parse check for the bigger files
            body = open(f, 'rb').read(3_000_000).decode('utf-8', 'replace')
            if not re.search(r'GitHub[\\/]prism-agent(?!-)', body):
                continue
        rel = '/'.join(f.relative_to(ROOT).parts)
        # keep only sessions whose cwd is the prism-agent repo itself (not prism-agent-R)
        name = rel.replace('/', '_').replace('.jsonl', '') + '.txt'
        digest_file(f, OUT / name)
        print(f, (OUT / name).stat().st_size)
    print('done ->', OUT)


if __name__ == '__main__':
    main()
