import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismLocalModelsService } from './src/service.ts'
import type { ResolvedConfig } from './src/config.ts'
const modelsRoot = join(tmpdir(), 'prism-lm-verify')
const config: ResolvedConfig = { pythonCommand: 'python', modelsRoot }
const real = new PrismLocalModelsService(config, modelsRoot)
await real.catalog()
console.log('installing bge small...')
await real.install('bge', 'bge-small-zh-v1.5')
for (let i = 0; i < 600; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const s = await real.status()
  const bge = s.families['bge']
  console.log(new Date().toISOString(), 'bge:', bge?.status, bge?.progress ? `${bge.progress.done}/${bge.progress.total}` : '', bge?.error ?? '')
  if (bge?.status !== 'downloading' && bge?.status !== 'provisioning') break
}
console.log('installing hy-mt q4_k_m...')
await real.install('hy-mt-1.5', 'q4_k_m')
for (let i = 0; i < 1500; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const s = await real.status()
  const mt = s.families['hy-mt-1.5']
  console.log(new Date().toISOString(), 'hy-mt:', mt?.status, mt?.progress ? `${mt.progress.done}/${mt.progress.total}` : '', mt?.error ?? '')
  if (mt?.status !== 'downloading' && mt?.status !== 'provisioning') break
}
const final = await real.catalog()
for (const f of final.families) console.log('FINAL', f.id, f.status, f.error ?? '')
