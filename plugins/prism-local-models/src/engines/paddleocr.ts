/**
 * PaddleOCR sidecar: a stdlib-only Python HTTP server running inside the
 * pip-provisioned venv, spoken to over loopback JSON. The sidecar binds an
 * ephemeral port and announces it on stdout; teardown kills the process.
 *
 * @module @prism/prism-local-models/engines/paddleocr
 */

import { spawn } from 'node:child_process'
import { access, constants, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalModelsError } from '../errors.ts'
import { runtimeDir, venvPython } from '../runtimes.ts'

/** The sidecar script: stdlib HTTP around the PaddleOCR Python API. */
const SIDECAR_SOURCE = String.raw`
import base64, json, sys, tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

engine = None

def get_engine():
    global engine
    if engine is None:
        from paddleocr import PaddleOCR
        engine = PaddleOCR(lang='ch')
    return engine

def extract(result):
    lines = []
    for page in result or []:
        if isinstance(page, dict):
            lines.extend(page.get('rec_texts') or [])
        elif isinstance(page, list):
            for item in page:
                if isinstance(item, (list, tuple)) and len(item) >= 2 and isinstance(item[1], (list, tuple)):
                    lines.append(item[1][0])
                elif isinstance(item, (list, tuple)) and len(item) >= 1 and isinstance(item[0], str):
                    lines.append(item[0])
    return lines

def run_image(path):
    e = get_engine()
    if hasattr(e, 'predict'):
        return extract(e.predict(path))
    return extract(e.ocr(path, cls=True))

def probe_image():
    from PIL import Image, ImageDraw
    image = Image.new('RGB', (480, 120), 'white')
    draw = ImageDraw.Draw(image)
    draw.text((24, 40), 'PRISM LOCAL OCR', fill='black')
    path = tempfile.mktemp(suffix='.png')
    image.save(path)
    return path

class Handler(BaseHTTPRequestHandler):
    def _json(self, value, status=200):
        body = json.dumps(value).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._json({'ok': True})
        else:
            self._json({'error': 'not found'}, 404)

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            payload = json.loads(self.rfile.read(length))
            if self.path == '/ocr':
                suffix = '.png' if 'png' in payload.get('mime', '') else '.jpg'
                path = tempfile.mktemp(suffix=suffix)
                with open(path, 'wb') as handle:
                    handle.write(base64.b64decode(payload['image']))
                self._json({'text': '\n'.join(run_image(path))})
            elif self.path == '/probe':
                self._json({'text': '\n'.join(run_image(probe_image()))})
            else:
                self._json({'error': 'not found'}, 404)
        except Exception as error:
            self._json({'error': str(error)}, 500)

    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print('PORT', server.server_port, flush=True)
server.serve_forever()
`

/** The running sidecar: loopback port, child process, OCR calls. */
export class PaddleOcrSidecar {
  private constructor(private readonly child: ReturnType<typeof spawn>, private readonly port: number) {}

  /**
   * Start the sidecar inside the pip-provisioned venv.
   * @param modelsRoot - the models root holding `runtimes/paddleocr/venv`.
   * @throws {LocalModelsError} `not-installed` when the venv is absent, `runtime-unavailable` when the sidecar or the PaddleOCR import fails.
   */
  static async open(modelsRoot: string): Promise<PaddleOcrSidecar> {
    const python = venvPython(modelsRoot, 'paddleocr')
    await access(python, constants.X_OK).catch(() => {
      throw new LocalModelsError('not-installed', 'the PaddleOCR environment is not provisioned; install a PaddleOCR variant from the Models page card first')
    })
    const scriptPath = join(runtimeDir(modelsRoot, 'paddleocr'), 'sidecar.py')
    await writeFile(scriptPath, SIDECAR_SOURCE, 'utf8')
    const child = spawn(python, [scriptPath], { cwd: runtimeDir(modelsRoot, 'paddleocr'), stdio: ['ignore', 'pipe', 'pipe'] })
    const sidecar = await new Promise<PaddleOcrSidecar>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => reject(new LocalModelsError('runtime-unavailable', `the PaddleOCR sidecar did not announce a port in 180s: ${stderr.trim().slice(-400)}`)), 180_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        const match = /^PORT (\d+)/m.exec(stdout)
        if (match !== null) {
          clearTimeout(timer)
          resolve(new PaddleOcrSidecar(child, Number(match[1])))
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}\n`.split('\n').slice(-20).join('\n')
      })
      child.on('error', error => {
        clearTimeout(timer)
        reject(new LocalModelsError('runtime-unavailable', `the PaddleOCR sidecar failed to start: ${error.message}`))
      })
      child.on('close', code => {
        clearTimeout(timer)
        reject(new LocalModelsError('runtime-unavailable', `the PaddleOCR sidecar exited ${code} before serving: ${stderr.trim().slice(-400)}`))
      })
    })
    // PaddleOCR loads (and first-run downloads) its models lazily on the first
    // OCR call, so /health only proves the HTTP loop is alive.
    return sidecar
  }

  /**
   * Extract text from one image through the sidecar.
   * @param image - raw image bytes with their MIME type.
   */
  async detectText(image: { readonly bytes: Uint8Array; readonly mime: string }): Promise<string> {
    const answer = await this.request<{ readonly text?: string; readonly error?: string }>('/ocr', {
      image: Buffer.from(image.bytes).toString('base64'),
      mime: image.mime,
    })
    if (answer.error !== undefined) throw new LocalModelsError('runtime-unavailable', `PaddleOCR detection failed: ${answer.error}`)
    return answer.text ?? ''
  }

  /** OCR the sidecar's own rendered probe image. */
  async probe(): Promise<string> {
    const answer = await this.request<{ readonly text?: string; readonly error?: string }>('/probe', {})
    if (answer.error !== undefined) throw new LocalModelsError('runtime-unavailable', `PaddleOCR probe failed: ${answer.error}`)
    return answer.text ?? ''
  }

  /** Kill the sidecar process. */
  dispose(): void {
    this.child.kill()
  }

  /** One JSON POST to the sidecar, with temp-file staging for larger bodies. */
  private async request<T>(path: string, body: object): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    })
    const value: unknown = await response.json()
    if (!response.ok) {
      const candidate = value as { error?: string }
      throw new LocalModelsError('runtime-unavailable', `PaddleOCR sidecar answered ${response.status}: ${candidate.error ?? response.statusText}`)
    }
    return value as T
  }
}
