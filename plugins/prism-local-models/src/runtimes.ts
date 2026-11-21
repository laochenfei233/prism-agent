/**
 * Runtime provisioning: npm and pip environments materialized under the
 * models root and imported through `createRequire`, because out-of-tree
 * plugins ship without `node_modules` and native runtimes must not be bundle
 * dependencies.
 *
 * @module @prism/prism-local-models
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, constants, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LocalModelsError } from './errors.ts'
import type { CatalogRuntime } from './catalog.ts'

/** Where one family's provisioned runtime lives. */
export function runtimeDir(modelsRoot: string, modelId: string): string {
  return join(modelsRoot, 'runtimes', modelId)
}

/** Import scope for `createRequire` inside one provisioned runtime. */
export function requireFrom(dir: string): NodeRequire {
  return createRequire(join(dir, 'package.json'))
}

/**
 * Pure command plan for one provisioning step; tests assert on plans, the
 * runner executes them.
 */
export interface ProvisionPlan {
  /** Executable launched directly (never through a shell). */
  readonly command: string
  /** argv, with the package list last. */
  readonly args: readonly string[]
  /** Working directory for the invocation. */
  readonly cwd: string
}

/**
 * Plan npm provisioning: node runs the npm CLI of the running runtime, so no
 * shell and no PATH lookup for `npm.cmd` are involved.
 */
export function planNpmProvision(dir: string, packages: readonly string[]): ProvisionPlan {
  const npmCli = join(dirnameOf(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return { command: process.execPath, args: [npmCli, 'install', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel', 'error', ...packages], cwd: dir }
}

/**
 * Plan pip provisioning into a dedicated venv next to the runtime dir.
 * @param dir - runtime directory; the venv lives at `<dir>/venv`.
 * @param packages - pip requirements.
 * @param pythonCommand - interpreter used to create the venv.
 */
export function planPipProvision(dir: string, packages: readonly string[], pythonCommand: string): ProvisionPlan[] {
  const venvDir = join(dir, 'venv')
  const venvPython = process.platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
  return [
    { command: pythonCommand, args: ['-m', 'venv', venvDir], cwd: dir },
    { command: venvPython, args: ['-m', 'pip', 'install', '--disable-pip-version-check', ...packages], cwd: dir },
  ]
}

/**
 * Provision a catalog runtime unless a marker records the same package list
 * already provisioned.
 * @returns the runtime directory.
 */
export async function provisionRuntime(modelsRoot: string, modelId: string, runtime: CatalogRuntime, pythonCommand: string, signal: AbortSignal): Promise<string> {
  const dir = runtimeDir(modelsRoot, modelId)
  const markerPath = join(dir, '.provisioned')
  const expected = JSON.stringify(runtime.packages)
  try {
    if (await readFile(markerPath, 'utf8') === expected) return dir
  } catch {
    // No marker: provision from scratch below.
  }
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const plans = runtime.kind === 'npm'
    ? [planNpmProvision(dir, runtime.packages)]
    : planPipProvision(dir, runtime.packages, pythonCommand)
  for (const plan of plans) {
    await runPlan(plan, signal)
  }
  await writeFile(markerPath, expected, 'utf8')
  return dir
}

/** The venv interpreter of a pip-provisioned runtime, for spawning the sidecar. */
export function venvPython(modelsRoot: string, modelId: string): string {
  const venvDir = join(runtimeDir(modelsRoot, modelId), 'venv')
  return process.platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
}

/** Directory holding the running node executable (its npm CLI lives beside it). */
function dirnameOf(execPath: string): string {
  return dirname(execPath)
}

/** Run one plan step; a nonzero exit or missing executable fails provision. */
async function runPlan(plan: ProvisionPlan, signal: AbortSignal): Promise<void> {
  // Only path-shaped commands are pre-checked: bare names (`python`) resolve
  // through PATH, and checking them against the cwd would falsely fail.
  if (/[\\/]/.test(plan.command)) {
    await access(plan.command, constants.X_OK).catch(() => {
      throw new LocalModelsError('provision-failed', `the provisioning executable does not exist: ${plan.command}`)
    })
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, [...plan.args], { cwd: plan.cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}\n`.split('\n').slice(-20).join('\n')
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new LocalModelsError('provision-failed', `${plan.command} ${plan.args.slice(0, 3).join(' ')} exited ${code}: ${stderr.trim() || 'no diagnostics'}`))
      }
    })
  }).catch(error => {
    if (error instanceof LocalModelsError) throw error
    throw new LocalModelsError('provision-failed', `provisioning failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}
