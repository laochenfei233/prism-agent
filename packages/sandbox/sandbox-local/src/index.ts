/**
 * Local sandbox backend. It selects the platform runner chain (Linux bwrap then
 * Landlock; macOS Seatbelt; Windows the ACL restricted-token runner), functionally probes
 * competing candidates once, and reports each wrap's enforcement and stderr
 * classification facts. Missing or unusable confinement fails closed rather
 * than returning the original argv.
 *
 * The windows-acl rung additionally owns the write grants: the write SID is
 * the per-WORKSPACE identity derived from the canonical workspace path
 * (`workspaceWriteSid`), while every live session receives a RANDOM private
 * temp directory and its own derived capability (`tempWriteSid`). The ACL
 * work itself runs in the package's grant-runner helper child — the
 * `SetNamedSecurityInfoW` tree propagation over a freshly granted workspace
 * can block for minutes on large trees, so it must never execute on the
 * server's event-loop thread. The provider derives the SIDs (pure string
 * derivation), spawns the child, and awaits its exit up to `grantTimeoutMs`;
 * a timed-out or aborted wait leaves the child running so the standing ACEs
 * land in the background and the exact-ACE skip turns the retry into O(1).
 * The workspace-root ACE materializes once per workspace per server lifetime
 * and STANDS (the cross-session reuse cache); the private-temp ACEs are
 * revoked on dispose through the same child. The runner receives both SIDs
 * (their presence marks the seam-managed contract) and stops managing DACLs
 * itself. The rung reports partial enforcement because NTFS hard links alias
 * one file object across paths, reads stay unconfined, and a tree another
 * AppContainer tool has ACL'd with a package SID is not readable by the
 * Low-integrity child.
 * @module @deepseek-ai/dsh-sandbox-local
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LAUNCHER_BIN,
  LAUNCHER_FAILURE_EXIT,
  launcherPath as landlockLauncherPath,
  probe as defaultProbeLandlock,
} from '@deepseek-ai/node-addon-system/landlock-run'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxProvider, SandboxUnavailableError, canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, ConfinedSandboxMode, RunnerFailureRule, SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { assertTempRootOutsideWorkspace, registerAclDiagnosisSkill, tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { bwrapProfileArgs, landlockProfileArgs, protectedRootsWithin, seatbeltProfileArgs } from './profiles.ts'

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * Override the runner argv; bwrap-compatible profile arguments are appended. A
   * non-empty override asserts full enforcement and skips built-in selection and
   * probing. A runner that starts but refuses its profile must be identifiable by
   * {@link runnerFailureSignatures}. Consumers classify a spawn rejection only after
   * confirming the workdir is usable. `ENOENT` or `EACCES` identifies the runner when
   * `error.path` equals argv[0] and `error.syscall` is `spawn` or `spawn <runner>`, or
   * when `error.path` is absent and `error.syscall` is exactly `spawn <runner>`.
   */
  runnerCommand?: string[]
  /**
   * Case-insensitive stderr substrings emitted when a configured
   * {@link runnerCommand} refuses its profile before executing the wrapped
   * command. Required and non-empty with `runnerCommand`; rejected without
   * it. Each entry is a non-empty, single-line, case-insensitive substring
   * covering the executable runner's own failure dialect.
   */
  runnerFailureSignatures?: string[]
  /** Positive timeout for each functional probe; zero would mean unbounded to Node. */
  probeTimeoutMs?: number
  /**
   * Positive wall-clock limit for WAITING on one grant-runner child (default
   * 120000). The child is never killed: an expired wait abandons it to finish
   * the standing ACEs in the background (the exact-ACE skip makes the next
   * provision O(1)) while the current command fails closed.
   */
  grantTimeoutMs?: number
}

/** Probe whether `bwrap` can create the profile; the provider caches the bounded result. */
function defaultProbeBwrap(timeoutMs: number): boolean {
  const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/**
 * Functional Seatbelt probe: apply the real `read-only` profile through
 * `sandbox-exec -p` and run `true` under it — exit 0 means the kernel
 * accepted and enforced the profile (`sandbox-exec` exits non-zero when
 * `sandbox_init` refuses it). A missing `sandbox-exec` (every non-macOS
 * host) fails the spawn and probes `unusable`, exactly like the other
 * rungs' absent binaries. Apple marks the CLI deprecated but ships it on
 * every macOS; if it ever disappears, this probe is what fails closed.
 */
function defaultProbeSeatbelt(seatbeltExec: string, timeoutMs: number): boolean {
  const probe = spawnSync(seatbeltExec, [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/**
 * Functional windows-acl probe: run the runner in read-only mode (zero grants,
 * no ACL mutation) around `cmd /c exit 0` — exit 0 means the runner created
 * the restricted token and spawned the child under it. The win32 chain is a
 * sole candidate, so the product never probes; the probe exists for override
 * chains and mirrors the other rungs' shape.
 */
function defaultProbeWindowsAcl(runnerInvocation: string[], timeoutMs: number): boolean {
  const program = runnerInvocation[0]
  if (program === undefined) return false
  const probe = spawnSync(program, [
    ...runnerInvocation.slice(1),
    '--workspace', tmpdir(), '--temp', tmpdir(), '--mode', 'read-only',
    '--', 'cmd', '/c', 'exit', '0',
  ], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/** Test hook: inject probe verdicts / a fake launcher / a platform without real runners. */
export interface SandboxInternals {
  /** Replaces `process.platform` for chain selection (exercise any platform's chain from any host). */
  platform?: string
  /** Replaces the platform's chain wholesale (walk mechanics — e.g. probing a rung the product chains only reach unprobed). */
  chain?: readonly SelectedRunner['runner'][]
  /** Replaces the functional `bwrap` probe (the Linux chain's first rung). */
  probeBwrap?: () => boolean
  /** Replaces the functional Landlock launcher probe (the Linux chain's second rung). */
  probeLandlock?: (launcher: string) => SandboxEnforcement | 'unusable'
  /** Replaces the functional Seatbelt probe (the darwin chain's sole rung — only consulted if that chain ever grows). */
  probeSeatbelt?: (seatbeltExec: string) => boolean
  /** Replaces the resolved `landlock-run` launcher path (a fake launcher script). */
  landlockLauncher?: string
  /** Replaces the `sandbox-exec` executable the probe and wraps invoke (a fake script). */
  seatbeltExec?: string
  /** Replaces the resolved windows-acl runner argv prefix (a fake runner). */
  windowsAclRunnerArgs?: string[]
  /** Replaces the resolved windows-acl runner built entry path (a fake lib/runner.js location). */
  windowsAclRunnerEntry?: string
  /** Replaces the resolved windows-acl grant-runner argv prefix (a fake grant runner). */
  windowsAclGrantRunnerArgs?: string[]
  /** Replaces the resolved windows-acl grant-runner built entry path (a fake lib/grant-runner.js location). */
  windowsAclGrantRunnerEntry?: string
  /** Replaces the functional windows-acl probe (the win32 chain's sole rung — only consulted if that chain ever grows). */
  probeWindowsAcl?: () => boolean
  /** Replaces the private-temp-directory removal at provider dispose (a throwing fake exercises the cleanup-failure path). */
  rmTempDir?: (path: string) => void
}

/** The chain's verdict: which runner confines, and how completely it enforces. */
type SelectedRunner = { runner: 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl'; enforcement: SandboxEnforcement }

/** One live session/workspace pair's private temp directory and capability. */
interface AclTempCapability {
  dir: string
  writeSid: string
}

/**
 * One grant-runner child's settled facts, each independent: how the child
 * exited, whether the WAIT expired before that (the child keeps running), and
 * the stderr captured for failure classification.
 */
interface GrantRunnerOutcome {
  /** Process exit code; null while still running or on spawn rejection. */
  exitCode: number | null
  /** Terminating signal; null for a normal exit. */
  signal: NodeJS.Signals | null
  /** Whether the wait gave up before the child exited (the child is abandoned, not killed). */
  timedOut: boolean
  /** Whether the caller's abort signal fired while waiting. */
  aborted: boolean
  /** Spawn rejection (ENOENT, EACCES, …); undefined on a successful spawn. */
  spawnError: Error | undefined
  /** Captured stderr, capped, for the `windows-acl-grant: ` failure signature. */
  stderr: string
}

/**
 * The runner chain per platform — selection is BY PLATFORM first, probes
 * second: a platform's chain is probed in preference order only when it has
 * MORE than one candidate (probing arbitrates; it does not re-validate a
 * choice that has no alternative). A platform with no chain fails closed at
 * `confine()`. Linux prefers `bwrap` (its mount profile is closest to the
 * mode vocabulary) over the Landlock launcher; darwin has exactly one
 * candidate, selected without any probe.
 */
const PLATFORM_CHAINS: Record<string, readonly SelectedRunner['runner'][]> = {
  linux: ['bwrap', 'landlock'],
  darwin: ['seatbelt'],
  // The Windows restricted-token runner (@deepseek-ai/dsh-sandbox-windows-acl):
  // a sole candidate, selected without a probe — its execution-time refusal
  // fails closed through its stderr signature (windows-acl-run:) and exit 127.
  win32: ['windows-acl'],
}

/**
 * Enforcement completeness a rung claims when selected WITHOUT a probe (a
 * chain of one). `bwrap` and Seatbelt govern every promised file effect by
 * construction, so the claim is a profile fact; `landlock` is listed for the
 * table's totality but is unreachable without a probe (the Linux chain has
 * two rungs, so it is only ever selected through its probe, whose report is
 * what distinguishes full from per-ABI-partial — and the launcher additionally
 * self-reports partial enforcement on stderr at every confined run).
 */
const STATIC_ENFORCEMENT: Record<SelectedRunner['runner'], SandboxEnforcement> = {
  bwrap: 'full',
  landlock: 'full',
  seatbelt: 'full',
  // Everyone stays in both restricting lists for process initialization, but
  // the Low label denies the write authority it used to confer. NTFS hard
  // links still alias a granted workspace file to a path outside it, reads
  // stay unconfined, and an AppContainer-ACL'd tree is unreadable to the
  // child: the backend enforces the remaining ACL-addressable surface but
  // must not advertise the absolute promise.
  'windows-acl': 'partial',
}

/**
 * A probe bound must be a positive finite number: Node treats
 * `spawnSync({ timeout: 0 })` as NO timeout, so an unvalidated 0 would
 * silently mean "unbounded" — the opposite of what the field promises.
 */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`sandbox-local: ${name} must be a positive finite number`)
  }
}

/**
 * The denial dialect each runner's kernel speaks — the case-insensitive stderr substrings a
 * denied file effect produces under it, carried on every wrap (the seam's
 * `ConfinedArgv.denialSignatures`).
 */
const DENIAL_SIGNATURES = {
  bwrap: ['read-only file system'],
  landlock: ['permission denied'],
  seatbelt: ['operation not permitted'],
  // pwsh/.NET: "Access to the path '...' is denied."; cmd: "Access is denied.";
  // Node EACCES: "permission denied"; EPERM: "operation not permitted".
  'windows-acl': ['access is denied', 'access to the path', 'permission denied', 'operation not permitted'],
  runnerCommand: ['read-only file system', 'permission denied'],
} as const satisfies Record<SelectedRunner['runner'] | 'runnerCommand', readonly string[]>

/** The windows-acl runner's documented failure exit (its own RUNNER_FAILURE_EXIT contract, distinct from Landlock's 125). */
const WINDOWS_ACL_RUNNER_FAILURE_EXIT = 127

/**
 * The grant runner's stderr failure signature (its GRANT_RUNNER_SIGNATURE
 * contract, printed on every runner-side ACL failure).
 */
const GRANT_RUNNER_FAILURE_SIGNATURE = 'windows-acl-grant: '

/**
 * The grant-runner child's environment: only the system roots and the temp
 * path its per-path ACL lock file needs (`GetTempPathW` reads `TMP`/`TEMP`).
 * No ambient entry — harness credentials and proxy variables never reach the
 * child, which spawns nothing and reads no user configuration.
 */
function grantChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'TEMP', 'TMP']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * Runner-owned fatal diagnostics. Landlock has a versioned exit-125 plus
 * fatal-line launcher-failure contract. Bubblewrap's current fatal paths exit
 * 1 but its public contract does not reserve that status, while sandbox-exec
 * publishes no launcher-failure status; those backends remain signature-only.
 * The windows-acl runner prints `windows-acl-run: <detail>` on every
 * runner-side failure and exits 127 — the rule is exit-gated on that status
 * so a confined command that merely PRINTS the signature (or a runner
 * cleanup failure reported on a non-zero child exit) is never misclassified
 * as "the command did not run". Keep the Landlock tuple aligned with the
 * assembled snapshot fixture at
 * `packages/test-support/session-snapshot/tests/fixtures/partial-landlock-sandbox.ts`.
 */
const RUNNER_FAILURE_RULES = {
  bwrap: [{ fatalSignatures: ['bwrap: '] }],
  landlock: [{
    allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
    fatalSignatures: [`${LAUNCHER_BIN}: `],
    informationalLines: [`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`],
  }],
  seatbelt: [{ fatalSignatures: ['sandbox-exec: '] }],
  'windows-acl': [{ allowedExitCodes: [WINDOWS_ACL_RUNNER_FAILURE_EXIT], fatalSignatures: ['windows-acl-run: '] }],
} as const satisfies Record<SelectedRunner['runner'], readonly RunnerFailureRule[]>

/**
 * Local process-sandbox provider. Registers as `ctx.sandbox`. Caches the
 * chain verdict and, on the windows-acl rung, the grant-runner memos (the
 * standing workspace-root grant per workspace and the revocable private-temp
 * grant per live session/workspace pair, the latter revoked on provider
 * dispose); the one-time probes spawn nothing else.
 */
export class LocalSandboxProvider extends SandboxProvider {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    runnerCommand: z.array(z.string()).default([]),
    runnerFailureSignatures: z.array(z.string()).default([]),
    probeTimeoutMs: z.natural().default(5_000),
    grantTimeoutMs: z.natural().default(120_000),
  })

  /** Test hook (mirrors the bash executors' `internals`). */
  internals: SandboxInternals = {}

  private readonly runnerCommand: string[] | undefined
  private readonly configuredRunnerFailureSignatures: string[]
  private readonly probeTimeoutMs: number
  private readonly grantTimeoutMs: number
  /** Cached chain verdict; undefined until the first confined wrap needs it. */
  private selectedRunner: SelectedRunner | 'unavailable' | undefined
  /**
   * Server-lifetime write-grant bookkeeping (windows-acl rung): an in-flight
   * memo per live session/workspace pair so concurrent commands share one
   * grant-runner child, plus the settled records teardown revokes. The maps
   * hold promises and plain data, not FFI objects — the ACEs live in the
   * filesystem; a rejected memo is dropped so the next command retries with a
   * fresh child (whose exact-entry skip makes a partially applied run cheap).
   * The standing workspace-root ACE is never revoked (the cross-session
   * reuse cache).
   */
  private readonly tempCapabilities = new Map<string, Promise<AclTempCapability>>()
  /** Settled temp capabilities, the teardown revoke list. */
  private readonly tempRecords = new Map<string, AclTempCapability>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // The schema (static Config) defaults every field — the casts record
    // those runtime facts. An empty runnerCommand means "not configured":
    // use the platform chain.
    const runner = config.runnerCommand as string[]
    const runnerFailureSignatures = config.runnerFailureSignatures as string[]
    if (runner.length === 0 && runnerFailureSignatures.length > 0) {
      throw new Error('sandbox-local: runnerFailureSignatures requires runnerCommand')
    }
    if (runner.length > 0 && runnerFailureSignatures.length === 0) {
      throw new Error('sandbox-local: runnerCommand requires at least one runnerFailureSignatures entry')
    }
    if (runnerFailureSignatures.some(signature => signature.trim().length === 0 || /[\r\n]/u.test(signature))) {
      throw new Error('sandbox-local: runnerFailureSignatures entries must be non-empty single-line strings')
    }
    this.runnerCommand = runner.length > 0 ? runner : undefined
    this.configuredRunnerFailureSignatures = runnerFailureSignatures
    this.probeTimeoutMs = config.probeTimeoutMs as number
    assertPositiveFinite('probeTimeoutMs', this.probeTimeoutMs)
    this.grantTimeoutMs = config.grantTimeoutMs as number
    assertPositiveFinite('grantTimeoutMs', this.grantTimeoutMs)
    // An operator-supplied runner does not use the ACL backend. The registry
    // remains optional and may be mounted after this provider.
    /* v8 ignore next 3 -- Windows-only registration; the Linux coverage lane cannot take this branch */
    if (process.platform === 'win32' && this.runnerCommand === undefined) {
      ctx.inject(['skills'], (skillsCtx) => { registerAclDiagnosisSkill(skillsCtx) })
    }
    // The temp grants are revoked with the provider: a clean server
    // shutdown leaves no temp ACEs behind (workspace ACEs stand by design —
    // the reuse cache; an unclean shutdown leaves them for the next
    // provision's exact-ACE skip). Teardown awaits the revoke children, so a
    // grant child still preparing when shutdown starts is abandoned, not
    // awaited — its ACEs land in the background either way.
    ctx.effect(() => async () => {
      await this.revokeAclGrants()
    })
  }

  /**
   * Wrap `argv` in the selected runner's invocation for `policy` — the configured
   * `runnerCommand` when present (the operator's assertion, no probe), else the platform
   * chain's runner speaking its own profile dialect.
   *
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @param signal - cancellation before policy resolution or grant creation.
   * @returns the wrapped argv plus the selected backend's enforcement completeness, denial
   *   signatures, and structured runner-failure rules; throws the fail-closed
   *   `SANDBOX_UNAVAILABLE` error when the platform has no usable runner.
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    policy = { ...policy, workspaceRoot: canonicalPath(policy.workspaceRoot) }
    if (this.runnerCommand !== undefined) {
      return Promise.resolve<ConfinedArgv>({
        argv: [...this.runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv],
        enforcement: 'full',
        denialSignatures: DENIAL_SIGNATURES.runnerCommand,
        runnerFailureRules: [{ fatalSignatures: this.configuredRunnerFailureSignatures }],
      })
    }
    const selected = this.selectRunner(policy.mode)
    const runnerArgv = await this.runnerArgv(selected.runner, policy, signal)
    return {
      argv: [...runnerArgv, '--', ...argv],
      enforcement: selected.enforcement,
      denialSignatures: DENIAL_SIGNATURES[selected.runner],
      runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
    }
  }

  /** The selected rung's runner invocation (program + profile arguments) for one policy. */
  private async runnerArgv(runner: SelectedRunner['runner'], policy: SandboxPolicy, signal?: AbortSignal): Promise<string[]> {
    switch (runner) {
      case 'bwrap': return ['bwrap', ...bwrapProfileArgs(policy)]
      case 'landlock': return [this.landlockLauncher(), ...landlockProfileArgs(policy)]
      case 'seatbelt': return [this.seatbeltExec(), ...seatbeltProfileArgs(policy)]
      case 'windows-acl': return this.windowsAclRunnerArgv(policy, signal)
      default: return assertNever(runner)
    }
  }

  /**
   * The windows-acl runner argv for one policy. With a calling session (the
   * policy's `sessionId`) under workspace-write, the grants are materialized
   * once per provider lifetime through the grant-runner helper child — the
   * standing workspace-root grant per workspace and a revocable, RANDOM
   * private-temp capability per live session/workspace pair. The runner
   * receives `--write-sid` plus `--temp-write-sid` and grants nothing itself.
   * Agentless workspace-write calls pass the ambient temp ROOT and no SID
   * flags: the runner creates and removes a random private child directory
   * for that one invocation.
   * @param policy - the resolved per-call policy.
   * @returns the runner invocation.
   */
  private async windowsAclRunnerArgv(policy: SandboxPolicy, signal?: AbortSignal): Promise<string[]> {
    const sessionId = policy.sessionId
    if (sessionId === undefined || policy.mode === 'read-only') {
      // The standalone runner manages its own DACLs, so the home denial travels
      // with the argv instead of a seam-materialized grant.
      const denied = protectedRootsWithin(policy)
        .filter(root => existsSync(root))
        .flatMap(root => ['--deny', root])
      return [
        ...this.windowsAclRunnerInvocation(),
        '--workspace', policy.workspaceRoot,
        '--temp', tmpdir(),
        '--mode', policy.mode,
        ...denied,
      ]
    }
    const temp = await this.materializeAclGrant(sessionId, policy.workspaceRoot, signal)
    return [
      ...this.windowsAclRunnerInvocation(),
      '--workspace', policy.workspaceRoot,
      '--temp', temp.dir,
      '--mode', policy.mode,
      '--write-sid', workspaceWriteSid(policy.workspaceRoot),
      '--temp-write-sid', temp.writeSid,
    ]
  }

  /**
   * Materialize one workspace-write policy's ACEs once per provider
   * lifetime, each apply running in the grant-runner helper child so the
   * tree propagation never blocks the server. The workspace SID and standing
   * root grant are shared by the workspace. The temp directory is random and
   * carries a distinct SID, so another session on the same workspace cannot
   * use the shared workspace SID to enter it. A fresh provider always
   * chooses a new path; crash residue therefore cannot collide with or
   * authorize a resumed session. Fail-closed: a failed temp grant removes
   * its random directory before the error propagates; a timed-out wait
   * abandons the child (the ACEs land in the background) and fails the
   * command with `SANDBOX_UNAVAILABLE`.
   * @param sessionId - the policy's calling-session identity.
   * @param workspaceRoot - the resolved policy root.
   * @param signal - cancellation observed while waiting for the children.
   * @returns the pair's private temp directory and write capability.
   */
  private async materializeAclGrant(
    sessionId: SessionId, workspaceRoot: string, signal?: AbortSignal,
  ): Promise<AclTempCapability> {
    assertTempRootOutsideWorkspace(workspaceRoot, tmpdir())
    const key = JSON.stringify([String(sessionId), workspaceRoot])
    let pending = this.tempCapabilities.get(key)
    if (pending === undefined) {
      pending = this.materializeAclGrantPair(workspaceRoot, key, signal)
      this.tempCapabilities.set(key, pending)
      // Drop a rejected memo so the next command retries with a fresh child;
      // the loser of a timed-out wait keeps running and its ACEs still land.
      pending.catch(() => {
        if (this.tempCapabilities.get(key) === pending) this.tempCapabilities.delete(key)
      })
    }
    return pending
  }

  /**
   * One pair's grant-runner invocation: the standing workspace-root ACE
   * (its exact-entry skip makes a repeat invocation O(1)), the harness-home
   * denies, and the pair's revocable temp ACE — one child for all three.
   */
  private async materializeAclGrantPair(
    workspaceRoot: string, key: string, signal?: AbortSignal,
  ): Promise<AclTempCapability> {
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-'))
    const tempSid = tempWriteSid(tempDir)
    try {
      // The standing workspace ACE inherits into everything below it, so a
      // harness home inside the workspace needs an explicit deny in front of
      // that inherited allow.
      const denyArgs = protectedRootsWithin({ mode: 'workspace-write', workspaceRoot })
        .filter(root => existsSync(root))
        .flatMap(root => ['--deny', root])
      const outcome = await this.runGrantRunner([
        '--workspace', workspaceRoot,
        '--write-sid', workspaceWriteSid(workspaceRoot),
        ...denyArgs,
        '--temp', tempDir,
        '--temp-write-sid', tempSid,
      ], signal)
      this.throwOnGrantRunnerFailure(`workspace grant under ${workspaceRoot}`, outcome, signal)
    } catch (error) {
      try {
        this.removeTempDir(tempDir)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'sandbox-local windows-acl temp grant materialization failed and its cleanup also failed')
      }
      throw error
    }
    const capability = { dir: tempDir, writeSid: tempSid }
    this.tempRecords.set(key, capability)
    return capability
  }

  /**
   * Spawn the grant-runner helper child and wait for its exit up to
   * `grantTimeoutMs`. The child is NEVER killed and never assigned to this
   * process's job: an expired or aborted wait abandons it so the standing
   * ACEs land in the background (a hub that exits mid-grant is exactly the
   * partial state the exact-ACE skip cannot repair). Every outcome fact —
   * exit code, signal, timeout, abort, spawn rejection, stderr — is reported
   * independently.
   */
  private runGrantRunner(args: readonly string[], signal?: AbortSignal): Promise<GrantRunnerOutcome> {
    const invocation = this.windowsAclGrantRunnerInvocation()
    const child = spawn(invocation[0] ?? '', [...invocation.slice(1), ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: grantChildEnv(),
      windowsHide: true,
    })
    return new Promise<GrantRunnerOutcome>((resolve) => {
      let stderr = ''
      const STDERR_CAP = 8 * 1024
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < STDERR_CAP) stderr += chunk
      })
      let settled = false
      const finish = (outcome: GrantRunnerOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      // An abandoned child keeps its stderr pipe alive from our side; close
      // it so the server can exit while the child finishes. The child writes
      // nothing on success, so a broken pipe costs only a failure that was
      // already failing.
      const abandon = (): void => {
        child.stderr.destroy()
      }
      const timer = setTimeout(() => {
        abandon()
        finish({ exitCode: child.exitCode, signal: child.signalCode, timedOut: true, aborted: false, spawnError: undefined, stderr })
      }, this.grantTimeoutMs)
      const onAbort = (): void => {
        abandon()
        finish({ exitCode: child.exitCode, signal: child.signalCode, timedOut: false, aborted: true, spawnError: undefined, stderr })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', (spawnError: Error) => {
        finish({ exitCode: null, signal: null, timedOut: false, aborted: false, spawnError, stderr })
      })
      child.on('close', (exitCode, signal) => {
        finish({
          exitCode, signal, timedOut: false, aborted: false, spawnError: undefined, stderr,
        })
      })
      // The child is never killed and never assigned to this process's job:
      // on Windows an unassigned child survives this process, so the grant
      // still lands after an abandoned wait or a server exit.
      child.unref()
    })
  }

  /**
   * Classify one grant-runner outcome and throw the fail-closed seam error,
   * or return when the child exited 0 before the wait expired. An aborted
   * wait rethrows the caller's abort reason; a timed-out wait names the
   * abandoned child's continuing work so the caller can retry later.
   */
  private throwOnGrantRunnerFailure(purpose: string, outcome: GrantRunnerOutcome, signal?: AbortSignal): void {
    if (outcome.aborted) throw signal?.reason ?? new Error(`sandbox-local: ${purpose} wait aborted`)
    if (outcome.exitCode === 0 && !outcome.timedOut && outcome.spawnError === undefined) return
    if (outcome.spawnError !== undefined) {
      throw new SandboxUnavailableError('workspace-write', `${purpose}: grant runner could not start: ${outcome.spawnError.message}`)
    }
    if (outcome.timedOut) {
      throw new SandboxUnavailableError(
        'workspace-write',
        `${purpose}: the grant runner did not finish within ${this.grantTimeoutMs}ms. `
        + 'The workspace preparation is still running in the background and later commands reuse it once it lands — retry this command.',
      )
    }
    const detail = outcome.stderr.split(/\r?\n/u).find(line => line.includes(GRANT_RUNNER_FAILURE_SIGNATURE))
    throw new SandboxUnavailableError(
      'workspace-write',
      `${purpose}: grant runner exited with code ${outcome.exitCode}${detail === undefined ? '' : `: ${detail.trim()}`}`,
    )
  }

  /**
   * The windows-acl grant-runner argv prefix, resolved like the confinement
   * runner's (built lib/ entry in production, package source through tsx in
   * development) and overridable by the same style of test hooks.
   */
  private windowsAclGrantRunnerInvocation(): string[] {
    const override = this.internals.windowsAclGrantRunnerArgs
    if (override !== undefined) return override
    const builtEntry = this.internals.windowsAclGrantRunnerEntry
      ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/grant-runner'))
    if (existsSync(builtEntry)) return [process.execPath, builtEntry]
    const sourceEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/src/grant-runner.ts'))
    const sourceConfig = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))
    const registration = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register({ tsconfig: ${JSON.stringify(sourceConfig)} });`
    return [process.execPath, '--import', `data:text/javascript,${encodeURIComponent(registration)}`, sourceEntry]
  }

  /**
   * Dispose every write grant (provider dispose): each settled temp
   * capability is revoked through a grant-runner child and its private
   * directory removed; the standing workspace ACEs stay (the reuse cache).
   * Cleanup failures are reported, not thrown: cordis teardown must not be
   * aborted by grant cleanup. A materialization still in flight at teardown
   * is abandoned — its random temp path and SID are never reused, so the
   * residue is exactly the crash case: OS temp hygiene (or manual removal)
   * eventually reclaims it, and a later provision's exact-ACE skip stays O(1).
   */
  private async revokeAclGrants(): Promise<void> {
    const settled = [...this.tempRecords.values()]
    this.tempCapabilities.clear()
    this.tempRecords.clear()
    if (settled.length === 0) return
    const failures: unknown[] = []
    await Promise.all(settled.map(async ({ dir, writeSid }) => {
      try {
        const outcome = await this.runGrantRunner(['--revoke', '--path', dir, '--write-sid', writeSid])
        // A still-running revoke child owns the directory: removing it now
        // would race the ACE rewrite, so the residue joins the crash case.
        if (outcome.timedOut || outcome.aborted) {
          const why = outcome.timedOut ? `wait exceeded ${this.grantTimeoutMs}ms` : 'teardown aborted'
          failures.push(new Error(`sandbox-local: temp revoke for ${dir} was abandoned while running (${why})`))
          return
        }
        if (outcome.spawnError !== undefined) failures.push(outcome.spawnError)
        if (outcome.exitCode !== 0) {
          const detail = outcome.stderr.split(/\r?\n/u).find(line => line.includes(GRANT_RUNNER_FAILURE_SIGNATURE))
          failures.push(new Error(`sandbox-local: temp revoke for ${dir} exited with code ${outcome.exitCode}`
            + (detail === undefined ? '' : `: ${detail.trim()}`)))
        }
        // The child exited (or never started), so the random directory is
        // ours to remove; its own failure is independent of the revoke's.
        try {
          this.removeTempDir(dir)
        } catch (error) {
          failures.push(error)
        }
      } catch (error) {
        failures.push(error)
      }
    }))
    if (failures.length > 0) {
      this.ctx.logger.warn(`sandbox-local: windows-acl grant cleanup completed with ${failures.length} failure(s)`)
      for (const error of failures) this.ctx.logger.warn(error)
    }
  }

  /** Remove one provider-owned private temp directory (injectable for cleanup tests). */
  private removeTempDir(dir: string): void {
    const remove = this.internals.rmTempDir ?? ((path: string) => { rmSync(path, { recursive: true, force: true }) })
    remove(dir)
  }

  /**
   * Resolve which runner confines commands, once, for the provider's
   * lifetime: this platform's chain ({@link PLATFORM_CHAINS}), its sole
   * candidate selected directly, multiple candidates arbitrated by
   * functional probes in chain order. Fail closed when the platform has no
   * chain or no candidate passes — the command never runs.
   */
  private selectRunner(mode: ConfinedSandboxMode): SelectedRunner {
    this.selectedRunner ??= this.chainVerdict()
    if (this.selectedRunner === 'unavailable') throw new SandboxUnavailableError(mode)
    return this.selectedRunner
  }

  /** Walk this platform's chain: sole candidate unprobed, several probed in order, none usable → unavailable. */
  private chainVerdict(): SelectedRunner | 'unavailable' {
    const chain = this.internals.chain ?? PLATFORM_CHAINS[this.internals.platform ?? process.platform] ?? []
    const [first, ...rest] = chain
    if (first === undefined) return 'unavailable'
    // A sole candidate needs no arbitration; its execution-time refusal still fails closed.
    if (rest.length === 0) return { runner: first, enforcement: STATIC_ENFORCEMENT[first] }
    for (const runner of chain) {
      const enforcement = this.probeRunner(runner)
      if (enforcement !== 'unusable') return { runner, enforcement }
    }
    return 'unavailable'
  }

  /** One rung's functional probe (each at most once, via the chain walk). */
  private probeRunner(runner: SelectedRunner['runner']): SandboxEnforcement | 'unusable' {
    // bwrap's mount profile and Seatbelt's deny-file-write* profile govern
    // every promised file effect by construction, so their passing probes
    // are always full enforcement; the Landlock launcher's probe report
    // distinguishes full from per-ABI-partial, while windows-acl is always
    // partial for its documented hard-link, unconfined-read, and
    // AppContainer-ACL boundaries.
    switch (runner) {
      case 'bwrap': {
        const probe = this.internals.probeBwrap ?? (() => defaultProbeBwrap(this.probeTimeoutMs))
        return probe() ? 'full' : 'unusable'
      }
      case 'landlock': {
        const probe = this.internals.probeLandlock ?? (launcher => defaultProbeLandlock(launcher, { timeoutMs: this.probeTimeoutMs }))
        return probe(this.landlockLauncher())
      }
      case 'seatbelt': {
        const probe = this.internals.probeSeatbelt ?? (exec => defaultProbeSeatbelt(exec, this.probeTimeoutMs))
        return probe(this.seatbeltExec()) ? 'full' : 'unusable'
      }
      case 'windows-acl': {
        const probe = this.internals.probeWindowsAcl
          ?? (() => defaultProbeWindowsAcl(this.windowsAclRunnerInvocation(), this.probeTimeoutMs))
        return probe() ? 'partial' : 'unusable'
      }
      default: return assertNever(runner)
    }
  }

  /** The Landlock launcher to probe and exec (test hook over the resolved one). */
  private landlockLauncher(): string {
    return this.internals.landlockLauncher ?? landlockLauncherPath()
  }

  /** The `sandbox-exec` executable to probe and exec (test hook over the system one). */
  private seatbeltExec(): string {
    return this.internals.seatbeltExec ?? 'sandbox-exec'
  }

  /**
   * The windows-acl runner argv prefix: the built lib/runner.js entry when
   * present (production), else the package source through tsx (development).
   * Pin the source loader and TypeScript paths to this installation, independently
   * of target cwd or environment overrides.
   * The prefix stays `[node, runner, ...]` — a future native-exe runner keeps
   * the same argv contract and only swaps these entries.
   */
  private windowsAclRunnerInvocation(): string[] {
    const override = this.internals.windowsAclRunnerArgs
    if (override !== undefined) return override
    const builtEntry = this.internals.windowsAclRunnerEntry ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
    if (existsSync(builtEntry)) return [process.execPath, builtEntry]
    const sourceEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts'))
    const sourceConfig = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))
    const registration = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register({ tsconfig: ${JSON.stringify(sourceConfig)} });`
    return [process.execPath, '--import', `data:text/javascript,${encodeURIComponent(registration)}`, sourceEntry]
  }
}

export default LocalSandboxProvider
