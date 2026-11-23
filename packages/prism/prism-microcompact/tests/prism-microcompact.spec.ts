import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, ToolCallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolResultMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import PrismMicrocompact, {
  DEFAULTS,
  MicrocompactPressureConfigError,
  microcompactSurface,
  resolveConfig,
  resolveThreshold,
  stubText,
} from '@prism/prism-microcompact'
import type { PrismMicrocompactConfig } from '@prism/prism-microcompact'

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

class WindowAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number | undefined) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.contextWindow === undefined ? {} : { context: { contextWindow: this.contextWindow } },
    })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class RejectingAdapter extends LlmAdapter {
  override resolveModel(): Promise<LlmResolvedModelInfo> {
    return Promise.reject(new Error('route lookup failed'))
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(contextWindow?: number, reject = false): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  // The registry is a required injection of TokenMeter (its three projection
  // units register in the constructor); mount it synchronously.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], reject ? new RejectingAdapter() : new WindowAdapter(contextWindow))
  return ctx
}

function service(ctx: Context, config: PrismMicrocompactConfig = { headroomTokens: 0, thresholdRatio: 0.5 }): PrismMicrocompact {
  return new PrismMicrocompact(ctx, config)
}

function agent(session: Session): Agent {
  return { session, options: {} } as Agent
}

/** One routed tool step per turn with an oversized text result. */
function toolSession(
  resultCount: number,
  toolName: (turn: number) => string = () => 'read',
  chars = 300,
  withHeader = true,
  imageTurn = 0,
): Session {
  const session = Session.create(SessionId(`micro-${resultCount}-${chars}`))
  for (let turn = 1; turn <= resultCount; turn += 1) {
    const callId = ToolCallId(`call-${turn}`)
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1 && withHeader) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `working on step ${turn}` },
          { type: 'tool-call', id: callId, name: toolName(turn), arguments: '{}' },
        ],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: toolName(turn), arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: turn === imageTurn
          ? [
            { type: 'text', text: `result ${turn} `.repeat(chars) },
            { type: 'image', attachment: {
              attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
            } },
          ]
          : [{ type: 'text', text: `result ${turn} `.repeat(chars) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

/** Tool-result surface texts in current surface order. */
function resultTexts(session: Session): string[] {
  const texts: string[] = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type === 'tool/result') {
      const message = session.deriveEventMessage(event) as ToolResultMessage
      texts.push(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    }
  }
  return texts
}

describe('microcompact configuration', () => {
  it('resolves detached immutable defaults and partial overrides', () => {
    const raw: PrismMicrocompactConfig = { thresholdRatio: 0.5, tools: ['read'] }
    const resolved = resolveConfig(raw)
    raw.thresholdRatio = 0.9
    expect(resolved).toEqual({ thresholdRatio: 0.5, headroomTokens: DEFAULTS.headroomTokens, keepRecentResults: DEFAULTS.keepRecentResults, tools: ['read'] })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.tools)).toBe(true)
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
    expect(DEFAULTS.tools).toBeUndefined()
  })

  it('rejects invalid configuration', () => {
    const bad = [
      [{ threshold: 10 }, /unknown key "threshold"/],
      [{ thresholdRatio: 0 }, /thresholdRatio .* within \(0, 1\]/],
      [{ thresholdRatio: 1.5 }, /thresholdRatio .* within \(0, 1\]/],
      [{ headroomTokens: -1 }, /headroomTokens .* non-negative integer/],
      [{ headroomTokens: 1.5 }, /headroomTokens .* non-negative integer/],
      [{ keepRecentResults: 0 }, /keepRecentResults .* positive integer/],
      [{ tools: [''] }, /tools entries must be non-empty/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as PrismMicrocompactConfig)).toThrow(pattern)
    }
  })
})

describe('arming threshold', () => {
  it('computes the documented default arm point below compaction', () => {
    expect(resolveThreshold(DEFAULTS, 'p/m', 1_000_000, 256_000)).toBe(612_928)
  })

  it('caps by ratio and by headroom budget', () => {
    expect(resolveThreshold(resolveConfig({ thresholdRatio: 0.5, headroomTokens: 0 }), 'p/m', 1000, 0)).toBe(500)
    expect(resolveThreshold(resolveConfig({ thresholdRatio: 0.9, headroomTokens: 50_000 }), 'p/m', 1_000_000, 256_000)).toBe(694_000)
  })

  it('rejects unusable capacities', () => {
    const config = resolveConfig({ thresholdRatio: 0.5, headroomTokens: 0 })
    expect(() => resolveThreshold(config, 'p/m', 0, 0)).toThrow(MicrocompactPressureConfigError)
    expect(() => resolveThreshold(config, 'p/m', 1000, -1)).toThrow(/non-negative integer/)
    expect(() => resolveThreshold(config, 'p/m', 1000, 1000)).toThrow(/no message budget/)
    expect(() => resolveThreshold(DEFAULTS, 'p/m', 1000, 0)).toThrow(/no microcompact budget/)
    expect(() => resolveThreshold(config, 'p/m', 1, 0)).toThrow(/arming threshold/)
  })
})

describe('microcompact surface pass', () => {
  function meterFor(): TokenMeter {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    return new TokenMeter(ctx)
  }

  it('clears stale results and keeps the most recent', () => {
    const session = toolSession(6, () => 'read', 300, true, 2)
    const result = microcompactSurface(session, meterFor(), resolveConfig({ keepRecentResults: 2 }))
    expect(result).not.toBeNull()
    expect(result!.cleared).toHaveLength(4)
    expect(result!.estimatedTokensFreed).toBeGreaterThan(0)

    const texts = resultTexts(session)
    expect(texts).toHaveLength(6)
    for (let index = 0; index < 4; index += 1) {
      expect(texts[index]).toBe(stubText('read'))
    }
    expect(texts[4]).toContain('result 5 ')
    expect(texts[5]).toContain('result 6 ')

    const prunes = session.snapshotEvents().filter(event => event.type === 'compaction/prune')
    expect(prunes).toHaveLength(4)
    expect(prunes[0]!.data.shadowedSeqs).toEqual([result!.cleared[0]!.originalSeq])
    expect(prunes[0]!.data.shadowedTokenCount).toBeGreaterThan(0)

    // Replacing result nodes with result nodes keeps every call paired.
    const derived = session.deriveMessages()
    const calls = derived
      .filter(message => message.role === 'assistant')
      .flatMap(message => message.content)
      .filter(block => block.type === 'tool-call').length
    const results = derived.filter(message => message.role === 'tool').length
    expect(calls).toBe(results)
  })

  it('is idempotent on an already-cleared surface', () => {
    const session = toolSession(6)
    const meter = meterFor()
    const config = resolveConfig({ keepRecentResults: 2 })
    expect(microcompactSurface(session, meter, config)).not.toBeNull()
    expect(microcompactSurface(session, meter, config)).toBeNull()
  })

  it('restricts clearing to configured tools', () => {
    const session = toolSession(6, turn => turn % 2 === 1 ? 'read' : 'web_search')
    const result = microcompactSurface(session, meterFor(), resolveConfig({ keepRecentResults: 2, tools: ['read'] }))
    expect(result).not.toBeNull()
    expect(result!.cleared.map(entry => entry.toolName)).toEqual(['read', 'read'])

    const texts = resultTexts(session)
    expect(texts[0]).toBe(stubText('read'))
    expect(texts[1]).toContain('result 2 ')
    expect(texts[2]).toBe(stubText('read'))
    expect(texts[3]).toContain('result 4 ')
    expect(texts[4]).toContain('result 5 ')
    expect(texts[5]).toContain('result 6 ')
  })

  it('keeps everything when nothing is stale', () => {
    const session = toolSession(2)
    expect(microcompactSurface(session, meterFor(), resolveConfig({ keepRecentResults: 4 }))).toBeNull()
  })

  it('skips results already no longer than the stub', () => {
    const session = toolSession(6, () => 'read', 8)
    expect(microcompactSurface(session, meterFor(), resolveConfig({ keepRecentResults: 2 }))).toBeNull()
  })

  it('names results without a surface tool/call event as unknown tool', () => {
    const session = Session.create(SessionId('micro-orphan'))
    session.append('turn/start', { turn: 1 })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('orphan'),
        content: [{ type: 'text', text: 'orphaned '.repeat(200) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    for (let turn = 2; turn <= 4; turn += 1) {
      appendPlainToolTurn(session, turn)
    }
    const result = microcompactSurface(session, meterFor(), resolveConfig({ keepRecentResults: 2 }))
    expect(result).not.toBeNull()
    expect(result!.cleared[0]!.toolName).toBe('unknown tool')
    expect(resultTexts(session)[0]).toBe(stubText('unknown tool'))
  })

  /** A plain routed tool turn without a preceding tool/call twin, for orphan tests. */
  function appendPlainToolTurn(session: Session, turn: number): void {
    const callId = ToolCallId(`call-${turn}`)
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `result ${turn} `.repeat(200) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
})

describe('pre-step guard listener', () => {
  function preStep(ctx: Context, owner: Agent, signal = SIGNAL): Promise<PreStepDecision> {
    return agentEvents(ctx, owner).waterfall(
      'agent/pre-step', { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
  }

  it('clears stale results above threshold and keeps the turn running', async () => {
    const ctx = createContext(1000)
    service(ctx)
    const session = toolSession(6)
    await preStep(ctx, agent(session))
    expect(session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(true)
  })

  it('stays idle below threshold', async () => {
    const ctx = createContext(1_000_000)
    service(ctx)
    const session = toolSession(2)
    await preStep(ctx, agent(session))
    expect(session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
  })

  it('skips aborted steps', async () => {
    const ctx = createContext(1000)
    service(ctx)
    const session = toolSession(6)
    const controller = new AbortController()
    controller.abort()
    await preStep(ctx, agent(session), controller.signal)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
  })

  it('warns once per target for unusable capacity', async () => {
    const ctx = createContext(200)
    service(ctx, {})
    const warn = vi.spyOn(ctx.logger, 'warn')
    const owner = agent(toolSession(6))
    await preStep(ctx, owner)
    await preStep(ctx, owner)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no microcompact budget'))
  })

  it('warns and continues when route resolution fails', async () => {
    const ctx = createContext(undefined, true)
    service(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const owner = agent(toolSession(6))
    await preStep(ctx, owner)
    await preStep(ctx, owner)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('microcompact failed: route lookup failed'))
  })

  it('stringifies non-Error failures in the warning', async () => {
    const ctx = createContext(1000)
    service(ctx)
    const owner = agent(toolSession(6))
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockRejectedValue('opaque')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await preStep(ctx, owner)
    expect(warn).toHaveBeenCalledWith('microcompact failed: opaque; continuing the turn')
  })
})

describe('pressure tracking', () => {
  it('reports the routed measurement and arm state', async () => {
    const ctx = createContext(1000)
    const guard = service(ctx)
    const snapshot = await guard.pressure(agent(toolSession(6)))
    expect(snapshot).not.toBeNull()
    expect(snapshot!.contextWindow).toBe(1000)
    expect(snapshot!.thresholdTokens).toBe(500)
    expect(snapshot!.totalTokens).toBeGreaterThan(500)
    expect(snapshot!.willMicrocompact).toBe(true)
  })

  it('reports a below-threshold conversation as idle', async () => {
    const ctx = createContext(1_000_000)
    const guard = service(ctx)
    const snapshot = await guard.pressure(agent(toolSession(2)))
    expect(snapshot).not.toBeNull()
    expect(snapshot!.willMicrocompact).toBe(false)
  })

  it('returns null without a durable routed request', async () => {
    const ctx = createContext(1000)
    const guard = service(ctx)
    const owner = agent(toolSession(6, () => 'read', 300, false))
    await expect(guard.pressure(owner)).resolves.toBeNull()
    await expect(guard.microcompactIfNeeded(owner, SIGNAL)).resolves.toBeNull()
  })

  it('returns null when the route declares no capacity', async () => {
    const ctx = createContext(undefined)
    const guard = service(ctx)
    const owner = agent(toolSession(6))
    await expect(guard.pressure(owner)).resolves.toBeNull()
  })
})
