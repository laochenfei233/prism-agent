/**
 * Route paths of the browser memory operations.
 *
 * One module for both faces: the Host registers these paths on Connection's
 * shared `/api` channel, and the browser requests them. They are absolute so a
 * document served below the root still reaches them.
 *
 * @module @prism/prism-memory/routes
 */

/** Counts, the review inbox, and the newest claims. */
export const MEMORY_OVERVIEW_PATH = '/api/prism-memory/overview'

/** Ranked claims for one literal query. */
export const MEMORY_SEARCH_PATH = '/api/prism-memory/search'

/** One operator write. */
export const MEMORY_REMEMBER_PATH = '/api/prism-memory/remember'

/** One review settlement. */
export const MEMORY_REVIEW_PATH = '/api/prism-memory/review'
