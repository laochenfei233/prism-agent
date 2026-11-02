#!/usr/bin/env node
// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2), area A8.
// Upstream ships this entry as bin `dsh`; this fork renames the bin to `prism`.
/**
 * Command-line entry for prism.
 * @module prism-agent/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { readDataHomePointer, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'
import type { RunProfileOptions } from './profile-boot.ts'

/**
 * Adopt the home a Settings-page relocation recorded, unless the operator
 * named one in the environment.
 *
 * The pointer is read once, before anything resolves the home: every service
 * captures the home at construction, so a launch must settle on one root
 * before the tree mounts. `$DSH_HOME` keeps precedence because a launcher
 * (including the desktop shell) forwards its own resolution through it.
 * @param env - the process environment to consult and update.
 * @param readPointer - pointer reader; omitted reads the launch pointer file.
 * @returns the adopted home, or undefined when the environment already named one.
 */
// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2), area A17.
export function applyDataHomePointer(
  env: NodeJS.ProcessEnv = process.env,
  readPointer: () => string | undefined = readDataHomePointer,
): string | undefined {
  const declared = env['DSH_HOME']
  if (declared !== undefined && declared.trim() !== '') return undefined
  const recorded = readPointer()
  if (recorded === undefined) return undefined
  env['DSH_HOME'] = recorded
  return recorded
}

/** Installation-owned dependencies supplied by a packaged CLI launcher. */
export type RunCliOptions = Pick<RunProfileOptions, 'packageManager'> & {
  /** Permit plugin commands for Desktop's existing profile; reserved for its installed carrier. */
  manageDesktopProfile?: boolean
}

/**
 * Run the public prism command-line interface.
 * @param options - Package runtime and Desktop profile access supplied by the installation.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  applyDataHomePointer()
  const version = getDshRuntimeVersion()
  const { manageDesktopProfile, ...profileOptions } = options
  const invocation = parseDshArgs(process.argv.slice(2), version, manageDesktopProfile)

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
          ...profileOptions,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (import.meta.main) {
  await runCli()
}
