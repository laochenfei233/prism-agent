/**
 * Provisioning contracts: npm runs through node + the npm CLI (no shell), pip
 * plans venv creation then installs, the marker short-circuits repeat work,
 * and capability calls on an uninstalled family fail typed.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../src/config.ts'
import { LocalModelsError } from '../src/errors.ts'
import { PrismLocalModelsService } from '../src/service.ts'
import { planNpmProvision, planPipProvision, provisionRuntime, runtimeDir } from '../src/runtimes.ts'

const root = await mkdtemp(join(tmpdir(), 'prism-local-models-rt-'))

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('provision plans', () => {
  it('plan npm through node and the npm CLI beside it', () => {
    const plan = planNpmProvision(join(root, 'runtimes', 'bge'), ['@huggingface/transformers@^3', 'onnxruntime-node'])
    expect(plan.command).toBe(process.execPath)
    expect(plan.args[0]).toMatch(/npm[\\/]bin[\\/]npm-cli\.js$/)
    expect(plan.args).toContain('--prefix')
    expect(plan.args.slice(-2)).toEqual(['@huggingface/transformers@^3', 'onnxruntime-node'])
  })

  it('plan pip as venv creation then an install into that venv', () => {
    const [venv, install] = planPipProvision(join(root, 'runtimes', 'paddleocr'), ['paddleocr'], 'py')
    expect(venv.command).toBe('py')
    expect(venv.args[0]).toBe('-m')
    expect(venv.args[1]).toBe('venv')
    expect(install.command).toMatch(/python(\.exe)?$/)
    expect(install.args.slice(-1)).toEqual(['paddleocr'])
  })
})

describe('provisionRuntime marker', () => {
  it('short-circuits when the marker records the same package list', async () => {
    const modelsRoot = join(root, 'models')
    const dir = runtimeDir(modelsRoot, 'bge')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.provisioned'), JSON.stringify(['pkg-a']), 'utf8')
    expect(await provisionRuntime(modelsRoot, 'bge', { kind: 'npm', packages: ['pkg-a'] }, 'python', new AbortController().signal)).toBe(dir)
  })
})

describe('capability guards', () => {
  it('fail embed with a typed not-installed error before any runtime loads', async () => {
    const config: ResolvedConfig = { pythonCommand: 'python' }
    const service = new PrismLocalModelsService(config, root)
    await service.catalog()
    await expect(service.embed(['x'])).rejects.toSatisfy((error: unknown) => error instanceof LocalModelsError && error.code === 'not-installed')
  })
})
