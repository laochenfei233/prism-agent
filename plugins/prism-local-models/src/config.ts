/**
 * Plugin configuration: where models live, where downloads come from, and
 * which interpreter manages the PaddleOCR environment.
 *
 * @module @prism/prism-local-models
 */

import Schema from '@deepseek-ai/schemastery'

/** Plugin configuration fields. */
export interface Config {
  /** Models root directory; defaults to `<home>/models`. */
  readonly modelsRoot?: string
  /**
   * Download mirror base replacing the `https://modelscope.cn` prefix of
   * catalog file URLs; unset keeps the built-in URLs.
   */
  readonly mirrorBaseUrl?: string
  /** Interpreter command for the PaddleOCR environment; defaults to `python`. */
  readonly pythonCommand?: string
  /**
   * Path to a JSON document merged over the built-in catalog; unknown fields
   * fail at load.
   */
  readonly catalogOverride?: string
}

/** Validated configuration with defaults applied. */
export type ResolvedConfig = Required<Pick<Config, 'pythonCommand'>> & Pick<Config, 'modelsRoot' | 'mirrorBaseUrl' | 'catalogOverride'>

/** Validate and default the plugin configuration. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  modelsRoot: Schema.string(),
  mirrorBaseUrl: Schema.string(),
  pythonCommand: Schema.string().default('python'),
  catalogOverride: Schema.string(),
}) as Schema<Config, ResolvedConfig>
