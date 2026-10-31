/**
 * Smoke: the injected desktop host bridge must speak the update-carrier
 * protocol the client and the shell page expect.
 *
 * Renders the bridge onto a fixture entry document and asserts the markers
 * both ends of the relay depend on: the `dshDesktop` carrier shape, the
 * allow-listed updater commands, the state-event name, and the injection's
 * idempotence (a re-run must not stack a second bridge).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectDesktopHostBridge } from './bundle-runtime.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '.bridge-smoke');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

try {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><html><head><title>fixture</title></head><body></body></html>\n',
  );

  injectDesktopHostBridge(dist);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const markers = [
    'dsh-desktop-host',
    'window.dshDesktop',
    'protocolVersion: 1',
    'prism_update_state',
    'prism_check_update',
    'prism_install_update',
    'prism://update-state',
    'updates',
  ];
  const missing = markers.filter((marker) => !html.includes(marker));
  if (missing.length > 0) {
    throw new Error(`injected bridge is missing markers: ${missing.join(', ')}`);
  }

  const occurrences = (text, needle) => text.split(needle).length - 1;
  const before = occurrences(html, 'window.dshDesktop');
  injectDesktopHostBridge(dist);
  const after = readFileSync(join(dist, 'index.html'), 'utf8');
  if (occurrences(after, 'window.dshDesktop') !== before) {
    throw new Error('bridge injection is not idempotent');
  }

  console.log('desktop host bridge smoke: OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
