/**
 * Headless smoke test for the browser half.
 *
 * Loads `lib/client.js` exactly the way the shell does — through the
 * `window.__ModuleLoader__.load` handoff, with the baseline modules supplied
 * by the injected `require` — then drives `apply` with a recording context and
 * renders the panel against a synthetic session list. It catches the failures
 * a bundler cannot: a wrong slot name, a registration option the slots service
 * rejects, and a render path that throws or reads a missing seat.
 *
 * Usage: node scripts/smoke.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(here, '../lib/client.js')

const rows = []

globalThis.window = {
  __ModuleLoader__: {
    load: (row) => { rows.push(row) },
  },
}

const require = createRequire(import.meta.url)
require(bundlePath)

if (rows.length !== 1) throw new Error(`expected one module row, received ${rows.length}`)
const [row] = rows
if (row.id !== 'dsh-agent-progress') throw new Error(`unexpected module id ${String(row.id)}`)

const baseline = {
  'react': {
    Fragment: Symbol('Fragment'),
    useEffect: (callback) => { callback() },
    useMemo: (factory) => factory(),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (value) => ({ current: value }),
  },
  'react/jsx-runtime': {
    Fragment: Symbol('Fragment'),
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  },
  '@deepseek-ai/dsh-client-store': {},
}

const bundle = row.factory(specifier => {
  const module = baseline[specifier]
  if (module === undefined) throw new Error(`undeclared module request: ${specifier}`)
  return module
})

const registrations = []
const effects = []
const ctx = {
  effect: (callback) => { effects.push(callback()) },
  locale: {
    register: (namespace, dictionaries) => {
      if (namespace !== 'agentProgress') throw new Error(`unexpected namespace ${namespace}`)
      if (dictionaries.zh === undefined || dictionaries.en === undefined) throw new Error('incomplete dictionaries')
      return () => {}
    },
    bind: () => key => key,
    resolveText: text => text.en ?? Object.values(text)[0] ?? '',
  },
  slots: {
    inject: (name, callback) => { callback() },
    register: (options, component) => {
      registrations.push({ name: options.name, key: options.key ?? options.id, component, options })
      return () => {}
    },
  },
  sessions: { refresh: async () => {} },
  uiWorkspace: { openSession: () => {} },
}

bundle.apply(ctx)

const expected = [
  { name: 'sidebar.panellist', key: 'agent-progress' },
  { name: 'main', key: 'agent-progress' },
]
for (const want of expected) {
  const found = registrations.some(entry => entry.name === want.name && entry.key === want.key)
  if (!found) {
    throw new Error(`missing registration ${want.name}#${want.key}; got ${registrations.map(e => `${e.name}#${e.key}`).join(', ')}`)
  }
}
const panelRow = registrations.find(entry => entry.name === 'sidebar.panellist')
if (typeof panelRow.options.label !== 'function') throw new Error('the sidebar row declares no label function')
if (!(typeof panelRow.options.order === 'number' && panelRow.options.order > 0)) {
  throw new Error('the sidebar row must sort below the shipped Plugins row (order 0)')
}

/**
 * Collect every string a rendered element tree carries, evaluating function
 * components (a two-line stand-in for React's render walk).
 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.type === 'style') return ''
  if (typeof node.type === 'function') return textOf(node.type(node.props ?? {}))
  return textOf(node.props?.children)
}

const todos = [
  { content: 'Read the design note', status: 'completed' },
  { content: 'Port the loader contract', status: 'completed' },
  { content: 'Wire the panel registrations', status: 'in_progress' },
  { content: 'Verify in the browser', status: 'pending' },
]
const list = {
  ids: ['session-a', 'session-b', 'session-c', 'session-d'],
  byId: {
    'session-a': {
      id: 'session-a',
      displayTitle: 'Build the progress panel',
      cwd: 'C:\\Users\\dev\\prism-agent',
      running: true,
      updatedAt: Date.now() - 5 * 60_000,
      projectionValues: { todos, goal: { objective: 'Ship the panel' }, plan: { active: true, pending: null } },
    },
    'session-b': {
      id: 'session-b',
      displayTitle: 'Idle session',
      cwd: '/home/dev/other',
      running: false,
      updatedAt: Date.now() - 3 * 3600_000,
      projectionValues: { todos: null },
    },
    'session-c': {
      id: 'session-c',
      displayTitle: 'Finished subagent',
      cwd: '/home/dev/other',
      parentId: 'session-a',
      origin: 'subagent',
      running: false,
      updatedAt: Date.now() - 30_000,
      projectionValues: { todos: [{ content: 'Do the thing', status: 'completed' }, { content: 'Wait', status: 'pending' }] },
    },
    'session-d': {
      id: 'session-d',
      displayTitle: 'Question pending',
      cwd: '/home/dev/other',
      running: false,
      updatedAt: Date.now() - 60_000,
      projectionValues: { todos: null },
    },
  },
}
const approvals = []
const status = new Map([
  ['session-a', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['session-b', {
    running: false,
    pendingInteraction: {
      kind: 'approval',
      key: 'approval:1',
      toolName: 'write',
      reason: 'Write notes.txt',
      displayReason: { en: 'Write notes.txt', zh: '写入 notes.txt' },
      answerable: true,
      answer: async (decision) => { approvals.push(decision) },
    },
    completionUnread: false,
  }],
  ['session-c', { running: false, pendingInteraction: undefined, completionUnread: true }],
  // Another interaction kind keeps its waiting chip and offers no approval strip.
  ['session-d', {
    running: false,
    pendingInteraction: { key: 'question:1', kind: 'question', sessionId: 'session-d' },
    completionUnread: false,
  }],
])

const page = registrations.find(entry => entry.name === 'main')
const inject = page.options.inject()
const opened = []
const pageProps = {
  ...inject,
  useSessions: selector => selector(list),
  useSessionStatus: selector => selector(status),
  t: key => key,
  openSession: sessionId => { opened.push(sessionId) },
  refresh: () => {},
}
const pageText = textOf(page.component(pageProps))
for (const needle of [
  'Build the progress panel', '2/4', 'progress panel', 'Ship the panel', 'prism-agent', 'waiting', 'unread', 'subagent',
]) {
  if (!pageText.includes(needle)) throw new Error(`page output is missing ${JSON.stringify(needle)}: ${pageText}`)
}

// The row opens the session; selecting a session is also how the panel closes.
/** Depth-first search over a rendered element tree with function components evaluated. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (typeof node.type === 'function') return findAll(node.type(node.props ?? {}), predicate, found)
  if (predicate(node)) found.push(node)
  return findAll(node.props?.children, predicate, found)
}

const rowElements = findAll(page.component(pageProps), node => node.props?.className === 'ap-row')
if (rowElements.length !== 4) throw new Error(`expected four session rows, received ${rowElements.length}`)
rowElements[0].props.onClick()
if (opened[0] !== 'session-a') throw new Error(`clicking the first row opened ${String(opened[0])}`)

// The approval renders under its own session with both decisions, and only
// there: the question-kind wait on session-d keeps its chip and no strip.
const strips = findAll(page.component(pageProps), node => node.props?.className === 'ap-approval')
if (strips.length !== 1) throw new Error(`expected one approval strip, received ${strips.length}`)
for (const needle of ['Write notes.txt', 'reject', 'allowOnce']) {
  const stripText = textOf(strips[0])
  if (!stripText.includes(needle)) throw new Error(`approval strip is missing ${JSON.stringify(needle)}: ${stripText}`)
}
const allow = findAll(page.component(pageProps), node => node.props?.className === 'ap-approval-allow')
if (allow.length !== 1) throw new Error(`expected one allow decision, received ${allow.length}`)
allow[0].props.onClick()
if (approvals.length !== 1 || approvals[0] !== 'allowed-once') {
  throw new Error(`the allow decision sent ${JSON.stringify(approvals)}`)
}

const iconText = textOf(panelRow.component({ size: 16, active: true }))
if (iconText.length > 0) throw new Error(`the sidebar glyph rendered text: ${iconText}`)

if (effects.length !== 1 || typeof effects[0] !== 'function') {
  throw new Error('apply registered no disposer for its dictionary effect')
}

console.log('smoke: ok — sidebar row (order 1) + main page registered, page renders, first row opens its session')
