/**
 * ZCode reader: the CLI keeps the shared `session`/`message`/`part` schema in
 * `~/.zcode/cli/db/db.sqlite`. Subagent sessions carry a `parent_id` and are
 * skipped by the shared scanner; harness-injected text parts are flagged
 * `synthetic` and filtered there too.
 *
 * @module @prism/prism-session-import/sources/zcode
 */

import { join } from 'node:path'
import { scanChatDatabase } from './mimo.ts'

/** ZCode store reader. */
export const zcodeReader = {
  id: 'zcode' as const,
  scan: (root: string) => scanChatDatabase(join(root, 'cli', 'db', 'db.sqlite'), 'zcode'),
}
