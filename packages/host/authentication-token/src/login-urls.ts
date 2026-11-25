/** Login-URL minting exposed by the default token plugin. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { BrowserAuth } from './browser-auth.ts'

/**
 * Mint the URLs a browser uses to sign in: the reusable launch link and the
 * single-use links a pairing flow hands to one approved device.
 */
export class TokenLoginUrls extends Service {
  private readonly auth: BrowserAuth

  /**
   * @param ctx - plugin scope owning this service.
   * @param auth - initialized token owner backing every minted URL.
   */
  constructor(ctx: Context, auth: BrowserAuth) {
    super(ctx, 'connection.tokenLogin')
    this.auth = auth
  }

  /**
   * Add this process's reusable launch token to the caller's application URL.
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @returns the URL carrying the launch token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    return this.auth.authenticatedUrl(baseUrl)
  }

  /**
   * Add a single-use token to the caller's application URL; the returned URL signs one browser in once.
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @param ttlMs - lifetime of the single-use token in milliseconds.
   * @returns the URL carrying the single-use token.
   */
  mintOneTimeLoginUrl(baseUrl: string, ttlMs: number): string {
    return this.auth.oneTimeLoginUrl(baseUrl, ttlMs)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Login-URL minting shared by the Host carrier and pairing flows. */
    'connection.tokenLogin': TokenLoginUrls
  }
}
