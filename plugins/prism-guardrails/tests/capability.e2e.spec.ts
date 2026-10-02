import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * End-to-end capability run: the shipped `headless` profile, composed by the
 * real Loader, with the bundle loaded from its BUILT artifact by relative path.
 *
 * The unit suite drives the extension points in one process; this proves the
 * facts only a real composition can: that a profile row resolves the built
 * entry, that the rails activate beside the shipped plan-mode, tool, and skill
 * plugins, and that the enforcement reaches a real model-visible tool result.
 *
 * The driver is spawned directly rather than through `@deepseek-ai/dsh-loader-smoke`,
 * whose launcher calls `import.meta.resolve` — unavailable inside this runner's
 * module graph. `src` mode is the mode the repository's own headless smoke uses:
 * `tsx` with the workspace `paths` map, so every package resolves to one source
 * instance.
 */

const PROCESS_TIMEOUT_MS = 150_000
const TEST_TIMEOUT_MS = 180_000

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const driverPath = join(repoRoot, 'packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts')
const tsconfigPath = join(repoRoot, 'tsconfig.json')
const tsxLoader = pathToFileURL(join(repoRoot, 'node_modules/tsx/dist/esm/index.mjs')).href

const TASK = 'exercise the capability rails'

/** Absolute path of one overlay fixture beside this spec. */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
}

/** One canonical session event, narrowed to the fields these assertions read. */
interface SessionEventRecord {
  readonly type: string
  readonly data: Record<string, unknown>
}

/** What one capability run produced. */
interface CapabilityRun {
  readonly events: readonly SessionEventRecord[]
  readonly result: Record<string, unknown> | undefined
  /** Both streams joined: the bundle's own log line is part of the evidence. */
  readonly output: string
}

/** One scripted model step. */
type Step = { readonly tool: string; readonly arguments: Record<string, unknown> } | { readonly text: string }

/** Spawn the headless driver from an isolated cwd and return both streams. */
async function spawnDriver(options: {
  readonly label: string
  readonly configPath: string
  readonly env: Readonly<Record<string, string>>
}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `prism-guardrails-${options.label}-`))
  try {
    const child = spawn(process.execPath, ['--import', tsxLoader, driverPath, options.configPath, TASK], {
      cwd,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: tsconfigPath,
        DSH_HOME: join(cwd, '.dsh'),
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`prism-guardrails ${options.label}: the driver exceeded ${PROCESS_TIMEOUT_MS} ms`))
      }, PROCESS_TIMEOUT_MS)
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
    })
    const out = Buffer.concat(stdout).toString()
    const err = Buffer.concat(stderr).toString()
    if (code !== 0) {
      throw new Error(`prism-guardrails ${options.label}: the driver exited ${String(code)}\n${err || out}`)
    }
    return `${out}\n${err}`
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

/**
 * Boot the headless profile with one overlay fixture and drive one turn.
 *
 * @param options - the overlay, the scripted model steps, and scenario switches.
 * @returns the session events, the driver's result record, and both streams.
 */
async function runCapability(options: {
  readonly label: string
  readonly overlay: string
  readonly script: readonly Step[]
  readonly env?: Readonly<Record<string, string>>
}): Promise<CapabilityRun> {
  const output = await spawnDriver({
    label: options.label,
    configPath: fixture(options.overlay),
    env: { ...options.env, PRISM_GUARDRAILS_SCRIPT: JSON.stringify(options.script) },
  })

  // Logger lines share stdout with the driver's JSONL, so keep the records that
  // parse and ignore the rest rather than assuming a clean stream.
  const records: Record<string, unknown>[] = []
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) records.push(parsed as Record<string, unknown>)
    } catch {
      // A non-JSON line is a log line, not driver output.
    }
  }
  const events: SessionEventRecord[] = []
  for (const record of records) {
    if (record['type'] !== 'session_event') continue
    const event = record['event'] as SessionEventRecord | undefined
    if (event !== undefined) events.push(event)
  }
  return {
    events,
    result: records.find(record => record['type'] === 'result'),
    output,
  }
}

/** Model-visible text of every `tool/result` event, in order. */
function toolResultTexts(events: readonly SessionEventRecord[]): string[] {
  return events
    .filter(event => event.type === 'tool/result')
    .map((event) => {
      const message = event.data['message'] as { content?: unknown } | undefined
      const content = message?.content
      if (!Array.isArray(content)) return ''
      return (content as { type?: unknown; text?: unknown }[])
        .map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : '')
        .join('')
    })
}

/** Names of every `tool/call` event, in order. */
function toolCallNames(events: readonly SessionEventRecord[]): string[] {
  return events
    .filter(event => event.type === 'tool/call')
    .map(event => String(event.data['name']))
}

/** How the last turn ended, as the loop recorded it. */
function lastTurnEndReason(events: readonly SessionEventRecord[]): string | undefined {
  const ending = events.filter(event => event.type === 'turn/end').at(-1)
  const reason = ending?.data['reason'] as { kind?: unknown } | undefined
  return typeof reason?.kind === 'string' ? reason.kind : undefined
}

describe('capability rails in a real headless profile', () => {
  it('refuses a plan-denied tool at the guard, not in the prompt', async () => {
    const run = await runCapability({
      label: 'plan-mode-denial',
      overlay: 'capability.patch.yml',
      script: [
        { tool: 'write', arguments: { file_path: 'plan.txt', content: 'x' } },
        { text: 'planning complete' },
      ],
      env: { PRISM_GUARDRAILS_PLAN: '1' },
    })

    expect(toolCallNames(run.events)).toEqual(['write'])
    expect(toolResultTexts(run.events)).toEqual([
      'Error: plan mode is active: `write` is not executed until the plan is approved; '
      + 'present the plan with exit_plan_mode or leave with /plan off',
    ])
    expect(run.result?.['output']).toBe('planning complete')
  }, TEST_TIMEOUT_MS)

  it('sends the call after the configured run to approval and refuses it unattended', async () => {
    const run = await runCapability({
      label: 'repeat-approval',
      overlay: 'capability.patch.yml',
      script: [
        ...Array.from({ length: 4 }, () => ({ tool: 'write', arguments: { file_path: 'repeat.txt', content: 'x' } })),
        { text: 'done repeating' },
      ],
    })

    expect(toolCallNames(run.events)).toEqual(['write', 'write', 'write', 'write'])
    const texts = toolResultTexts(run.events)
    // The threshold itself ran; both later calls were sent to approval, and this
    // deployment's approval service reports no channel, so the fail-closed
    // ladder refused them. The reason this bundle supplies reaches the approver,
    // not the model, which is why the model reads the registry's own wording.
    expect(texts.filter(text => text.includes('requires approval'))).toEqual([
      'Error: tool "write" requires approval, but no approval channel is available',
      'Error: tool "write" requires approval, but no approval channel is available',
    ])
    expect(texts.filter(text => !text.includes('requires approval'))).toHaveLength(2)
    expect(run.result?.['output']).toBe('done repeating')
  }, TEST_TIMEOUT_MS)

  it('cuts a turn off at the configured step budget', async () => {
    const run = await runCapability({
      label: 'turn-budget',
      overlay: 'budget.patch.yml',
      // The step is sticky, so only the rail can end this turn.
      script: [{ tool: 'write', arguments: { file_path: 'budget.txt', content: 'x' } }],
    })

    expect(toolCallNames(run.events)).toEqual(['write', 'write'])
    // The rail refuses the over-budget step, and the loop records the refusal as
    // the turn ending. The log line that names the budget is asserted by the
    // unit suite, which mounts the plugin where the logger is observable.
    expect(lastTurnEndReason(run.events)).toBe('blocked')
    expect(run.result?.['type']).toBe('result')
  }, TEST_TIMEOUT_MS)

  it('names the gesture that would load a user-only skill', async () => {
    const run = await runCapability({
      label: 'skill-guidance',
      overlay: 'capability.patch.yml',
      script: [
        { tool: 'skill', arguments: { name: 'scenario-user-only' } },
        { text: 'skill unavailable' },
      ],
      env: { PRISM_GUARDRAILS_USER_ONLY_SKILL: 'scenario-user-only' },
    })

    expect(toolCallNames(run.events)).toEqual(['skill'])
    expect(toolResultTexts(run.events)).toEqual([
      'Error: skill "scenario-user-only" is user-invoked only: '
      + 'ask the user to type /scenario-user-only in their next message',
    ])
    expect(run.result?.['output']).toBe('skill unavailable')
  }, TEST_TIMEOUT_MS)
})
