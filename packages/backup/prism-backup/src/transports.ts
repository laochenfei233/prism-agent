/**
 * The three remote transports behind one interface: WebDAV over HTTP verbs,
 * S3 over signed HTTP, and SMB through the operating system's own file session.
 * Every method maps provider failures onto the feature's codes — a rejected
 * credential is `auth-failed`, an unreachable or refusing server is
 * `connection-failed`, and a refused archive write is `upload-failed` — so the
 * settings page can name what to fix.
 * @module @prism/prism-backup/transports
 */

import { openAsBlob } from 'node:fs'
import { access, copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import type { BackupTarget } from './config.ts'
import { targetLabel } from './config.ts'
import { BackupError, asBackupError } from './error.ts'
import { UNSIGNED_PAYLOAD, signHeaders } from './sigv4.ts'

/** One remote store archives are written to. */
export interface Transport {
  /** Sanitized endpoint label the run record keeps. */
  readonly endpoint: string
  /**
   * Prove the store is reachable and accepts the configured credential.
   * @returns the sentence describing what answered.
   */
  test(): Promise<string>
  /**
   * Write one staged file to the store.
   * @param filePath - absolute staging file path.
   * @param key - path below the store root.
   */
  upload(filePath: string, key: string): Promise<void>
  /**
   * List the object names below one prefix.
   * @param prefix - path prefix, always ending at a directory boundary.
   * @returns object names, in store order.
   */
  list(prefix: string): Promise<readonly string[]>
  /**
   * Remove one object; a missing object is not a failure.
   * @param key - path below the store root.
   */
  remove(key: string): Promise<void>
}

/** Injectable edges so every failure path stays testable. */
export interface TransportDeps {
  /** HTTP carrier; defaults to the process-global fetch. */
  readonly fetch?: typeof fetch
  /** Windows `net use` bootstrap; defaults to spawning it. */
  readonly runNetUse?: (share: string, username: string, password: string) => Promise<void>
  /** Host platform; defaults to the running one. */
  readonly platform?: NodeJS.Platform
  /** Share extraction for one SMB path; defaults to {@link uncShareOf}. */
  readonly shareOfPath?: (path: string) => string | undefined
  /** Clock the S3 signature uses. */
  readonly now?: () => Date
}

/**
 * Whether a status means the credential was refused.
 * @param status - HTTP status.
 * @returns true for 401 and 403.
 */
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403
}

/**
 * Read a short body excerpt for a diagnostic message.
 * @param response - failed response.
 * @returns the trimmed text, bounded to one line.
 */
async function bodyExcerpt(response: Response): Promise<string> {
  const text = await response.text()
  const trimmed = text.replace(/\s+/gu, ' ').trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

/**
 * Build the basic-auth header value.
 * @param username - user name; an empty value sends no header.
 * @param password - password.
 * @returns the header value, or `undefined`.
 */
function basicAuth(username: string, password: string): string | undefined {
  if (username === '') return undefined
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

/**
 * Encode one relative object key for a URL path.
 * @param key - slash-separated key.
 * @returns the encoded path.
 */
function encodedKey(key: string): string {
  return key.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/**
 * The WebDAV store: PUT to write, MKCOL for missing collections, PROPFIND to
 * list, DELETE to rotate.
 */
class WebdavTransport implements Transport {
  readonly endpoint: string
  private readonly base: string
  private readonly auth: string | undefined
  private readonly fetch: typeof fetch

  /**
   * @param baseUrl - server base URL with any trailing slash removed.
   * @param username - basic-auth user name.
   * @param password - basic-auth password.
   * @param deps - injectable carrier.
   */
  constructor(baseUrl: string, username: string, password: string, deps: TransportDeps) {
    this.base = baseUrl
    this.auth = basicAuth(username, password)
    this.fetch = deps.fetch ?? fetch
    this.endpoint = baseUrl
  }

  private url(key: string): string {
    return key === '' ? this.base : `${this.base}/${encodedKey(key)}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.auth === undefined ? {} : { authorization: this.auth }, ...extra }
  }

  private async send(
    method: string,
    key: string,
    init: RequestInit & { readonly headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return await this.fetch(this.url(key), {
      ...init,
      method,
      headers: this.headers(init.headers),
    })
  }

  /** @inheritdoc */
  async test(): Promise<string> {
    const response = await this.send('PROPFIND', '', {
      headers: { depth: '0', 'content-type': 'application/xml' },
      body: PROPFIND_BODY,
    }).catch((error: unknown) => {
      throw asBackupError(error, 'prism-backup/connection-failed', `WebDAV ${this.base} is unreachable`)
    })
    if (isAuthStatus(response.status)) {
      throw new BackupError(
        'prism-backup/auth-failed',
        `WebDAV refused the stored user name or password (HTTP ${String(response.status)}).`,
      )
    }
    if (response.status !== 207 && !response.ok) {
      throw new BackupError(
        'prism-backup/connection-failed',
        `WebDAV answered HTTP ${String(response.status)} for ${this.base}: ${await bodyExcerpt(response)}`,
      )
    }
    return `WebDAV answered HTTP ${String(response.status)} at ${this.base}.`
  }

  /** @inheritdoc */
  async upload(filePath: string, key: string): Promise<void> {
    const body = await openAsBlob(filePath)
    const put = async (): Promise<Response> => await this.send('PUT', key, {
      body,
      headers: { 'content-type': 'application/zip' },
    }).catch((error: unknown) => {
      throw asBackupError(error, 'prism-backup/upload-failed', `WebDAV upload to ${this.url(key)} failed`)
    })
    let response = await put()
    if (response.status === 409 || response.status === 404) {
      await this.ensureParents(key)
      response = await put()
    }
    if (isAuthStatus(response.status)) {
      throw new BackupError('prism-backup/auth-failed', 'WebDAV refused the stored credential while uploading.')
    }
    if (!response.ok) {
      throw new BackupError(
        'prism-backup/upload-failed',
        `WebDAV refused the archive (HTTP ${String(response.status)}): ${await bodyExcerpt(response)}`,
      )
    }
  }

  /**
   * Create every missing collection on the way to one key.
   * @param key - the object key whose parents to create.
   */
  private async ensureParents(key: string): Promise<void> {
    const segments = key.split('/').slice(0, -1)
    for (let index = 1; index <= segments.length; index += 1) {
      const collection = segments.slice(0, index).join('/')
      const response = await this.send('MKCOL', collection).catch((error: unknown) => {
        throw asBackupError(error, 'prism-backup/connection-failed', `WebDAV could not create ${collection}`)
      })
      // 201 created, 405 already exists; both leave the collection usable.
      if (response.status !== 201 && response.status !== 405 && !isAuthStatus(response.status)) {
        throw new BackupError(
          'prism-backup/upload-failed',
          `WebDAV could not create the collection ${collection} (HTTP ${String(response.status)}).`,
        )
      }
    }
  }

  /** @inheritdoc */
  async list(prefix: string): Promise<readonly string[]> {
    const response = await this.send('PROPFIND', prefix, {
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: PROPFIND_BODY,
    }).catch((error: unknown) => {
      throw asBackupError(error, 'prism-backup/connection-failed', 'WebDAV listing failed')
    })
    if (!response.ok && response.status !== 207) {
      throw new BackupError(
        'prism-backup/connection-failed',
        `WebDAV listing answered HTTP ${String(response.status)}.`,
      )
    }
    const text = await response.text()
    const names: string[] = []
    for (const match of text.matchAll(/<(?:d:)?href>([^<]*)<\/(?:d:)?href>/gu)) {
      /* v8 ignore next 2 -- the single capture always participates; the guards document hostile input. */
      const raw = match[1] ?? ''
      const tail = raw.replace(/\/+$/u, '').split('/').pop()
      /* v8 ignore next -- a matched href always has a last segment. */
      const name = safeDecode(tail ?? '')
      if (name !== '' && name !== '..') names.push(name)
    }
    return names
  }

  /** @inheritdoc */
  async remove(key: string): Promise<void> {
    const response = await this.send('DELETE', key).catch((error: unknown) => {
      throw asBackupError(error, 'prism-backup/connection-failed', 'WebDAV delete failed')
    })
    if (response.status === 404) return
    if (!response.ok) {
      throw new BackupError(
        'prism-backup/upload-failed',
        `WebDAV could not delete ${key} (HTTP ${String(response.status)}).`,
      )
    }
  }
}

/** Body every PROPFIND sends; Depth decides whether the listing includes children. */
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'

/**
 * Percent-decode one href segment, leaving a malformed escape as it arrived
 * rather than failing the whole listing.
 * @param text - the encoded segment.
 * @returns the decoded segment, or the original text when it is not decodable.
 */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch (_malformedEscape) {
    return text
  }
}

/**
 * Decode the XML entities S3 object names may contain.
 * @param text - raw XML text.
 * @returns decoded text.
 */
function decodeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/** The S3 store: path- or virtual-host-addressed requests signed with SigV4. */
class S3Transport implements Transport {
  readonly endpoint: string
  private readonly base: URL
  private readonly fetch: typeof fetch
  private readonly now: () => Date

  /**
   * @param target - resolved S3 target.
   * @param deps - injectable carrier and clock.
   */
  constructor(private readonly target: Extract<BackupTarget, { type: 's3' }>, deps: TransportDeps) {
    this.base = new URL(`${target.endpoint.replace(/\/+$/u, '')}/`)
    if (!target.pathStyle) this.base.host = `${target.bucket}.${this.base.host}`
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? (() => new Date())
    this.endpoint = targetLabel(target)
  }

  private url(key: string, query = ''): URL {
    const prefix = this.target.pathStyle ? `/${encodeURIComponent(this.target.bucket)}` : ''
    const path = key === '' ? `${prefix}/` : `${prefix}/${encodedKey(key)}`
    return new URL(`${path}${query}`, this.base)
  }

  private async send(method: string, key: string, query: string, body?: Blob): Promise<Response> {
    const url = this.url(key, query)
    const headers = signHeaders({
      method,
      url,
      headers: { 'x-amz-content-sha256': UNSIGNED_PAYLOAD },
      payloadHash: UNSIGNED_PAYLOAD,
      region: this.target.region,
      service: 's3',
      credentials: { accessKeyId: this.target.accessKeyId, secretAccessKey: this.target.secretAccessKey },
      date: this.now(),
    })
    return await this.fetch(url, {
      method,
      headers,
      ...body === undefined ? {} : { body },
    }).catch((error: unknown) => {
      throw asBackupError(error, 'prism-backup/connection-failed', `S3 ${this.endpoint} is unreachable`)
    })
  }

  /** @inheritdoc */
  async test(): Promise<string> {
    const response = await this.send('GET', '', '?list-type=2&max-keys=1')
    if (isAuthStatus(response.status)) {
      throw new BackupError(
        'prism-backup/auth-failed',
        `S3 refused the access key pair (HTTP ${String(response.status)}).`,
      )
    }
    if (!response.ok) {
      throw new BackupError(
        'prism-backup/connection-failed',
        `S3 answered HTTP ${String(response.status)} for ${this.endpoint}: ${await bodyExcerpt(response)}`,
      )
    }
    return `S3 answered with the bucket listing for ${this.endpoint}.`
  }

  /** @inheritdoc */
  async upload(filePath: string, key: string): Promise<void> {
    const response = await this.send('PUT', key, '', await openAsBlob(filePath))
    if (isAuthStatus(response.status)) {
      throw new BackupError('prism-backup/auth-failed', 'S3 refused the access key pair while uploading.')
    }
    if (!response.ok) {
      throw new BackupError(
        'prism-backup/upload-failed',
        `S3 refused the archive (HTTP ${String(response.status)}): ${await bodyExcerpt(response)}`,
      )
    }
  }

  /** @inheritdoc */
  async list(prefix: string): Promise<readonly string[]> {
    const query = `?list-type=2&prefix=${encodeURIComponent(prefix === '' ? '' : `${prefix}/`)}`
    const response = await this.send('GET', '', query)
    if (!response.ok) {
      throw new BackupError(
        'prism-backup/connection-failed',
        `S3 listing answered HTTP ${String(response.status)}.`,
      )
    }
    const text = await response.text()
    // ListObjectsV2 answers full keys; rotation reasons about names within the
    // listed directory, like every other transport.
    const prefixWithSlash = prefix === '' ? '' : `${prefix}/`
    return [...text.matchAll(/<Key>([^<]*)<\/Key>/gu)].flatMap((match) => {
      /* v8 ignore next -- the single capture always participates. */
      const key = decodeXml(match[1] ?? '')
      return key.startsWith(prefixWithSlash) ? [key.slice(prefixWithSlash.length)] : []
    })
  }

  /** @inheritdoc */
  async remove(key: string): Promise<void> {
    const response = await this.send('DELETE', key, '')
    if (response.status === 404) return
    if (!response.ok) {
      throw new BackupError(
        'prism-backup/upload-failed',
        `S3 could not delete ${key} (HTTP ${String(response.status)}).`,
      )
    }
  }
}

/**
 * The `\\server\share` part of a Windows path that `net use` can connect.
 * @param path - UNC path or mapped drive.
 * @returns the share root, or `undefined` for a path `net use` cannot help with.
 */
export function uncShareOf(path: string): string | undefined {
  const match = /^(\\\\[^\\/]+\\[^\\/]+)(?:[\\/]|$)/u.exec(path)
  return match?.[1]
}

/**
 * Spawn `net use` to open an SMB session for the current Windows user.
 * @param share - the share root to connect.
 * @param username - stored user name.
 * @param password - stored password, visible in the process table for this call.
 */
/* v8 ignore start -- runs the OS `net` command; every caller injects a double in tests. */
async function spawnNetUse(share: string, username: string, password: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('net', ['use', share, password, `/user:${username}`], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`net use exited with ${String(code)}`))
    })
  })
}
/* v8 ignore stop */

/**
 * The SMB store: ordinary file-system calls against a UNC path or a mounted
 * directory, so credentials normally belong to the operating system's session.
 * A path the session cannot open is retried once after a Windows `net use`
 * bootstrap when the page stored a user name and password.
 */
class SmbTransport implements Transport {
  readonly endpoint: string
  private readonly platform: NodeJS.Platform
  private readonly shareOfPath: (path: string) => string | undefined
  private readonly runNetUse: (share: string, username: string, password: string) => Promise<void>
  private bootstrapped = false

  /**
   * @param target - resolved SMB target.
   * @param deps - injectable platform and bootstrap.
   */
  constructor(private readonly target: Extract<BackupTarget, { type: 'smb' }>, deps: TransportDeps) {
    this.platform = deps.platform ?? process.platform
    this.shareOfPath = deps.shareOfPath ?? uncShareOf
    this.runNetUse = deps.runNetUse ?? spawnNetUse
    this.endpoint = targetLabel(target)
  }

  /**
   * Run one file-system action, retrying once after a Windows session bootstrap.
   * @param action - the file-system action.
   * @param fallback - failure code when the retry also fails.
   * @param context - sentence prefix naming the operation.
   * @param code - backup code for the wrapped failure.
   * @returns the action's value.
   */
  private async withSession<T>(
    action: () => Promise<T>,
    code: 'prism-backup/connection-failed' | 'prism-backup/upload-failed' | 'prism-backup/auth-failed',
    context: string,
  ): Promise<T> {
    try {
      return await action()
    } catch (first: unknown) {
      const share = this.shareOfPath(this.target.root)
      if (this.bootstrapped || this.platform !== 'win32' || share === undefined
        || this.target.username === '' || this.target.password === '') {
        throw asBackupError(first, code, context)
      }
      this.bootstrapped = true
      try {
        await this.runNetUse(share, this.target.username, this.target.password)
      } catch (error: unknown) {
        throw asBackupError(error, 'prism-backup/auth-failed', 'Windows could not open the SMB share')
      }
      try {
        return await action()
      } catch (second: unknown) {
        throw asBackupError(second, code, context)
      }
    }
  }

  /** @inheritdoc */
  async test(): Promise<string> {
    await this.withSession(async () => {
      const info = await stat(this.target.root)
      if (!info.isDirectory()) throw new Error(`${this.target.root} is not a directory`)
      await access(this.target.root, fsConstants.W_OK)
    }, 'prism-backup/connection-failed',
    `SMB ${this.target.root} is not writable; on macOS and Linux mount the share first`)
    return `SMB directory ${this.target.root} is writable.`
  }

  /** @inheritdoc */
  async upload(filePath: string, key: string): Promise<void> {
    await this.withSession(async () => {
      const destination = fileIn(this.target.root, key)
      await mkdir(directoryOf(destination), { recursive: true })
      await copyFile(filePath, destination)
    }, 'prism-backup/upload-failed', `SMB could not write ${key}`)
  }

  /** @inheritdoc */
  async list(prefix: string): Promise<readonly string[]> {
    return await this.withSession(async () => {
      const entries = await readdir(fileIn(this.target.root, prefix))
      return entries.filter(name => !name.endsWith('.tmp'))
    }, 'prism-backup/connection-failed', 'SMB listing failed')
  }

  /** @inheritdoc */
  async remove(key: string): Promise<void> {
    await this.withSession(async () => {
      await unlink(fileIn(this.target.root, key)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      })
    }, 'prism-backup/upload-failed', `SMB could not delete ${key}`)
  }
}

/**
 * Join one key onto an absolute root with platform separators.
 * @param root - absolute root directory.
 * @param key - slash-separated key.
 * @returns the absolute path.
 */
function fileIn(root: string, key: string): string {
  const tail = key.split('/').filter(segment => segment !== '').join('/')
  return tail === '' ? root : `${root.replace(/[\\/]+$/u, '')}/${tail}`
}

/**
 * The directory part of a slash-joined path.
 * @param path - absolute path.
 * @returns its parent directory.
 */
function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

/**
 * Build the transport for one resolved target.
 * @param target - resolved target.
 * @param deps - injectable carrier, clock, platform, and bootstrap.
 * @returns the transport the runner drives.
 */
export function createTransport(target: BackupTarget, deps: TransportDeps = {}): Transport {
  if (target.type === 'webdav') return new WebdavTransport(target.baseUrl, target.username, target.password, deps)
  if (target.type === 's3') return new S3Transport(target, deps)
  return new SmbTransport(target, deps)
}
