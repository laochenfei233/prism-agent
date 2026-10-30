/** Target resolution, exclusion parsing, and the failures a half-filled target earns. */

import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_PROJECT_EXCLUDES, normalizeRemoteDir, parseExcludes, resolveBackup, resolveTarget, targetLabel } from '../src/config.ts'
import { BackupError } from '../src/error.ts'
import type { BackupSecretId } from '../src/types.ts'

type Resolved = ReturnType<typeof Config>

/**
 * Fill the live configuration from one plain section.
 * @param section - overrides applied over the schema defaults.
 * @returns the resolved configuration references.
 */
function configured(section: Record<string, unknown> = {}): Resolved {
  return Config({ ...section })
}

/**
 * A secret reader holding fixed values.
 * @param stored - the values it answers with, by id.
 * @returns the reader.
 */
function secrets(stored: Partial<Record<BackupSecretId, string>> = {}): (id: BackupSecretId) => Promise<string | undefined> {
  return async id => stored[id]
}

describe('backup configuration', () => {
  it('splits exclusions on lines and commas and drops blank entries', () => {
    expect(parseExcludes('.git\n node_modules, ,dist\n')).toEqual(['.git', 'node_modules', 'dist'])
  })

  it('normalizes the remote directory and refuses a traversal segment', () => {
    expect(normalizeRemoteDir('/prism-backups/')).toBe('prism-backups')
    expect(normalizeRemoteDir('a\\b')).toBe('a/b')
    expect(() => normalizeRemoteDir('../escape')).toThrow(/must not contain/u)
  })

  it('resolves a WebDAV target with its stored password', async () => {
    const resolved = await resolveTarget(configured({ webdavUrl: 'https://dav.example.com/x/', username: 'me' }),
      secrets({ 'webdav-password': 'pw' }))
    expect(resolved).toEqual({ type: 'webdav', baseUrl: 'https://dav.example.com/x', username: 'me', password: 'pw' })
    expect(targetLabel(resolved)).toBe('https://dav.example.com/x')
  })

  it('names the missing field instead of guessing a target', async () => {
    const failure = await resolveTarget(configured(), secrets()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BackupError)
    expect(failure).toMatchObject({ code: 'prism-backup/not-configured' })
    expect((failure as Error).message).toMatch(/WebDAV URL/u)
  })

  it('names the credential reference when no password is stored', async () => {
    const failure = await resolveTarget(configured({ webdavUrl: 'https://dav.example.com' }), secrets())
      .catch((error: unknown) => error)
    expect((failure as Error).message).toMatch(/PRISM_BACKUP_WEBDAV_PASSWORD/u)
  })

  it('derives the AWS endpoint when the S3 endpoint is empty', async () => {
    const resolved = await resolveTarget(configured({
      targetType: 's3', s3Region: 'eu-west-1', s3Bucket: 'bucket', s3AccessKeyId: 'AKIA',
    }), secrets({ 's3-secret-key': 'shh' }))
    expect(resolved).toMatchObject({
      type: 's3', endpoint: 'https://s3.eu-west-1.amazonaws.com', bucket: 'bucket', pathStyle: false,
    })
    expect(targetLabel(resolved)).toBe('https://s3.eu-west-1.amazonaws.com/bucket')
  })

  it('keeps a self-hosted S3 endpoint and path-style addressing', async () => {
    const resolved = await resolveTarget(configured({
      targetType: 's3', s3Endpoint: 'http://minio.local:9000/', s3Bucket: 'b', s3AccessKeyId: 'k', s3PathStyle: true,
    }), secrets({ 's3-secret-key': 's' }))
    expect(resolved).toMatchObject({ endpoint: 'http://minio.local:9000', pathStyle: true })
  })

  it('resolves an SMB target without any stored password', async () => {
    const resolved = await resolveTarget(configured({ targetType: 'smb', smbPath: '\\\\server\\share' }), secrets())
    expect(resolved).toEqual({ type: 'smb', root: '\\\\server\\share', username: '', password: '' })
  })

  it('carries content switches, exclusions, and retention into the resolved policy', async () => {
    const resolved = await resolveBackup(configured({
      targetType: 'smb', smbPath: 'D:\\backup', includeMemory: false, maxBackups: 0, projectExcludes: 'vendor\ntmp',
    }), secrets())
    expect(resolved.content).toEqual({
      settings: true,
      memory: false,
      projects: true,
      excludes: new Set(['vendor', 'tmp']),
      maxBackups: 0,
      remoteDir: 'prism-backup',
    })
  })

  it('ships the default exclusions in the schema default text', () => {
    const resolved = configured()
    expect(parseExcludes(resolved.projectExcludes.get())).toEqual([...DEFAULT_PROJECT_EXCLUDES])
    expect(resolved.targetType.get()).toBe('webdav')
    expect(resolved.maxBackups.get()).toBe(10)
  })
})
