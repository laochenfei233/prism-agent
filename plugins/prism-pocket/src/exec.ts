/**
 * Process execution shared by the local CLI probes. Both probes fail soft: a
 * machine without Tailscale or cloudflared is a normal deployment.
 *
 * @module @prism/prism-pocket/exec
 */

import { execFile } from 'node:child_process'

/** Injectable process runner; arguments mirror `child_process.execFile`. */
export type ExecRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>

/** Default runner around `child_process.execFile`; a failure with no stdout rejects. */
export const runProcess: ExecRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { ...options, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null && stdout === '') {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      resolve({ stdout, stderr })
    })
  })
