/**
 * Real-composition verification for the Prism memory bundle.
 *
 * It drives the shipping `dsh` CLI — not an in-process hand-built context —
 * through two real turns of a resumed session, against the repository's
 * Messages-compatible mock provider, and prints the concrete requests the model
 * adapter received. That is the evidence for the three claims that cannot be
 * shown by a unit spec: the static prompt section, the fixed tool surface, and
 * a recall block that lands at the request tail and only when something matched.
 *
 * Usage (from the repository root):
 *   node --import tsx/esm .tmp-build/prism-memory-verify.mts
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '../packages/test-support/llm-mock-server/src/index.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/** The claim turn one stores, and a turn-two ask that must match it. */
const CLAIM = 'the prism memory domain must stay at schema version 1'
const TASK_ONE = 'Record what we decided about the prism memory domain schema version.'
const TASK_TWO = 'What did we decide about the prism memory domain schema version?'
/** An ask that shares nothing with the stored claim, so nothing may be injected. */
const TASK_THREE = 'Explain how to configure the terminal bell character.'

/** One captured request body, reduced to the fields under test. */
interface CapturedRequest {
  readonly attempt: number
  readonly behavior: string
  readonly system: string
  readonly toolNames: readonly string[]
  readonly messages: readonly unknown[]
}

/** Run one `dsh` task and return its stdout. */
function runDsh(task: string, sessionId: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  // Two launch modes: the repository source CLI (default), or a packaged dsh
  // runtime with its own home, which is what a bundled desktop app runs.
  const runtimeNode = process.env['MEMORY_VERIFY_RUNTIME_NODE']
  const runtimeBin = process.env['MEMORY_VERIFY_RUNTIME_BIN']
  const executable = runtimeNode ?? process.execPath
  const args = runtimeNode !== undefined && runtimeBin !== undefined
    ? [runtimeBin, '--profile', 'headless', '--json']
    : ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'headless', '--json']
  if (sessionId !== undefined) args.push('--session-id', sessionId)
  args.push(task)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`dsh exited ${String(code)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`))
    })
  })
}

/** The session id the run adopted or created, read from its event stream. */
function sessionIdOf(events: string): string {
  for (const line of events.split('\n')) {
    if (line.trim() === '') continue
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as Record<string, unknown>
    for (const key of ['sessionId', 'session_id', 'id']) {
      const value = record[key]
      if (typeof value === 'string' && value.includes('session')) return value
    }
    const data = record['data']
    if (typeof data === 'object' && data !== null) {
      const nested = data as Record<string, unknown>
      for (const key of ['sessionId', 'session_id', 'id']) {
        const value = nested[key]
        if (typeof value === 'string' && value.includes('session')) return value
      }
    }
  }
  throw new Error(`no session id in the run events:\n${events}`)
}

/** Reduce every captured request to the fields under test. */
function capture(requests: readonly { attempt: number, behavior: string, body: unknown }[]): CapturedRequest[] {
  return requests.map((request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const system = typeof body['system'] === 'string'
      ? body['system']
      : Array.isArray(body['system'])
        ? (body['system'] as readonly { text?: string }[]).map(block => block.text ?? '').join('\n')
        : ''
    const tools = Array.isArray(body['tools']) ? body['tools'] as readonly { name?: string }[] : []
    const messages = Array.isArray(body['messages']) ? body['messages'] as readonly unknown[] : []
    return {
      attempt: request.attempt,
      behavior: request.behavior,
      system,
      toolNames: tools.map(tool => tool.name ?? '(unnamed)'),
      messages,
    }
  })
}

/** Print every tool result the model received, in full. */
function printToolResults(captured: readonly CapturedRequest[]): void {
  for (const request of captured) {
    for (const message of request.messages) {
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const block of content as readonly { type?: string, content?: unknown }[]) {
        if (block.type !== 'tool_result') continue
        const value = block.content
        const text = typeof value === 'string'
          ? value
          : Array.isArray(value)
            ? (value as readonly { text?: string }[]).map(part => part.text ?? '').join('')
            : JSON.stringify(value)
        console.log(`--- tool result in request #${request.attempt} ---\n${text}`)
      }
    }
  }
}

const server = await startMockLlmServer({
  host: '127.0.0.1',
  port: 0,
  apiKey: 'mock-key',
  sequence: ['tool_call_success', 'success'],
  repeatLast: true,
  toolName: process.env['MEMORY_VERIFY_TOOL'] ?? 'memory_remember',
  toolArguments: process.env['MEMORY_VERIFY_ARGS']
    ?? JSON.stringify({ text: CLAIM, kind: 'decision', scope: 'global', tags: ['schema', 'domain'] }),
})

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DEEPSEEK_BASE_URL: `${server.baseURL}/v1`,
  DEEPSEEK_API_KEY: 'mock-key',
  // The host environment routes HTTP through a local proxy; the mock provider
  // listens on loopback, so the child talks to it directly.
  http_proxy: '',
  https_proxy: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
}

try {
  console.log(`mock provider on ${server.baseURL}/v1`)

  const firstEvents = await runDsh(TASK_ONE, undefined, env)
  writeFileSync(new URL('./run-1-events.jsonl', import.meta.url), firstEvents)
  const sessionId = sessionIdOf(firstEvents)
  console.log(`turn 1 adopted session ${sessionId}`)
  console.log(`turn 1 final message: ${firstEvents.trim().split('\n').at(-1) ?? '(none)'}`)

  const secondEvents = await runDsh(TASK_TWO, sessionId, env)
  writeFileSync(new URL('./run-2-events.jsonl', import.meta.url), secondEvents)
  console.log(`turn 2 events written`)

  const thirdEvents = await runDsh(TASK_THREE, sessionId, env)
  writeFileSync(new URL('./run-3-events.jsonl', import.meta.url), thirdEvents)
  console.log(`turn 3 events written`)

  const captured = capture(server.requests)
  writeFileSync(new URL('./captured-requests.json', import.meta.url), JSON.stringify(captured, null, 2))
  console.log(`captured ${captured.length} request(s)`)
  printToolResults(captured)

  for (const request of captured) {
    const memoryTools = request.toolNames.filter(name => name.startsWith('memory_'))
    const lengths = request.messages.map((message) => {
      const typed = message as { role?: string, content?: unknown }
      const text = typeof typed.content === 'string'
        ? typed.content
        : Array.isArray(typed.content)
          ? (typed.content as readonly { text?: string }[]).map(block => block.text ?? '').join('')
          : ''
      return `${typed.role ?? '?'}:${text.length}`
    })
    console.log([
      `#${request.attempt} (${request.behavior})`,
      `  system chars=${request.system.length} has-protocol=${request.system.includes('memory_search')}`,
      `  memory tools=${memoryTools.length} [${memoryTools.join(', ')}]`,
      `  messages=${request.messages.length} [${lengths.join(' | ')}]`,
    ].join('\n'))
  }
} finally {
  await server.close()
}
