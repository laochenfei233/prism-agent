/** Build signed CUA helper applications into the verified payload tarball the npm packaging consumes. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execa } from 'execa'
import { create, extract } from 'tar'
import { CUA_APPLICATION, CUA_ARCHITECTURES, CUA_MANIFEST, readCuaApplication, sealCuaApplication, verifyCuaHelperPayload, type CuaHelperManifest } from './payload.ts'

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: false })
  if (process.platform !== 'darwin' || !values.out) throw new Error('Usage on macOS: package.ts --out <new-output-directory>')
  // This tree carries no desktop release environment, so the codesign identity and the manifest's
  // Apple team come straight from the environment; notarization and its keychain and proxy
  // machinery are absent here and are not performed.
  const signingIdentity = process.env.DSH_DESKTOP_MACOS_SIGNING_IDENTITY
  const teamId = process.env.DSH_DESKTOP_MACOS_TEAM_ID
  if (signingIdentity === undefined || signingIdentity === '') {
    throw new Error('CUA helper packaging requires DSH_DESKTOP_MACOS_SIGNING_IDENTITY in the environment')
  }
  if (teamId === undefined || !/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error('CUA helper packaging requires DSH_DESKTOP_MACOS_TEAM_ID in the environment as a 10-character Apple team identifier')
  }
  const root = resolve(import.meta.dirname, '../..')
  const output = resolve(values.out)
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  mkdirSync(output, { recursive: false })
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-cua-package-'))
  const controller = new AbortController()
  const stop = (): void => { controller.abort() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const run = async (command: string, args: string[]): Promise<void> => {
    await execa(command, args, { cwd: root, stdio: 'inherit', cancelSignal: controller.signal, killDescendants: true })
  }
  const verify = async (application: string, architecture: 'arm64' | 'x64'): Promise<void> => {
    await run('/usr/bin/lipo', ['-verify_arch', architecture === 'x64' ? 'x86_64' : 'arm64', join(application, 'Contents/MacOS/dsh-cua-native')])
  }
  try {
    const payload = join(scratch, 'payload')
    const applications: CuaHelperManifest['applications'] = []
    for (const architecture of CUA_ARCHITECTURES) {
      controller.signal.throwIfAborted()
      const directory = join(payload, 'native/bin', `darwin-${architecture}`)
      await run('/usr/bin/xcrun', ['python3', join(root, 'packages/experimental/cua-macos/native/build_app.py'),
        '--arch', architecture === 'x64' ? 'x86_64' : 'arm64', '--scratch-path', join(scratch, `swift-${architecture}`),
        '--output-directory', directory, '--identity', `Developer ID Application: ${signingIdentity}`])
      const { application } = readCuaApplication(directory)
      await verify(application, architecture)
      applications.push({ architecture, bundle: sealCuaApplication(directory, application) })
    }
    const manifest: CuaHelperManifest = { schemaVersion: 1, version, commit, teamId, applications }
    writeFileSync(join(payload, CUA_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    verifyCuaHelperPayload(payload, { version, commit })
    const archive = join(output, 'cua-helper.tgz')
    await create({ cwd: payload, file: archive, gzip: true, portable: true }, [CUA_MANIFEST, 'native'])
    const extracted = join(scratch, 'extracted')
    mkdirSync(extracted)
    await extract({ cwd: extracted, file: archive, strict: true })
    verifyCuaHelperPayload(extracted, { version, commit })
    for (const { architecture, bundle } of applications) {
      const application = join(extracted, 'native/bin', `darwin-${architecture}`, bundle, CUA_APPLICATION)
      await verify(application, architecture)
    }
    writeFileSync(join(output, CUA_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`CUA helper artifact: ${archive}`)
  } catch (error) {
    rmSync(join(output, 'cua-helper.tgz'), { force: true })
    throw error
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    rmSync(scratch, { recursive: true, force: true })
  }
}

await main()
