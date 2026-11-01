/**
 * Engine contracts: every spec is keyless and builds one request; HTML engines
 * read their result links (unwrapping redirects) and API engines read JSON.
 */
import { describe, expect, it } from 'vitest'
import { ENGINE_SPECS, type EngineSpec } from '../src/engines.ts'

/** The spec under test. */
function specOf(id: string): EngineSpec {
  const found = ENGINE_SPECS.find(spec => spec.id === id)
  if (found === undefined) throw new Error(`missing engine ${id}`)
  return found
}

describe('engine catalog', () => {
  it('exposes eighteen distinct keyless engines', () => {
    expect(ENGINE_SPECS).toHaveLength(18)
    expect(new Set(ENGINE_SPECS.map(spec => spec.id)).size).toBe(18)
    for (const spec of ENGINE_SPECS) {
      const request = spec.build('deepseek harness')
      expect(request.url.startsWith('https://')).toBe(true)
      expect(request.headers?.['authorization']).toBeUndefined()
      expect(request.url).toContain(encodeURIComponent('deepseek harness'))
    }
  })

  it('selects Chinese parameters for a Chinese query', () => {
    expect(specOf('bing').build('深度求索').url).toContain('mkt=zh-CN')
    expect(specOf('bing').build('deepseek').url).toContain('mkt=en-US')
    expect(specOf('wikipedia').build('深度求索').url).toContain('zh.wikipedia.org')
    expect(specOf('wikipedia').build('deepseek').url).toContain('en.wikipedia.org')
  })
})

describe('DuckDuckGo HTML', () => {
  it('unwraps the redirect and reads the following excerpt', () => {
    const html = `
      <div class="result results_links">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example page title</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">The excerpt text.</a>
      </div>
      <div class="nav-link"><a href="https://duckduckgo.com/settings">Settings</a></div>`
    const hits = specOf('duckduckgo').parse(html, 'https://html.duckduckgo.com/html/')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ url: 'https://example.com/page', title: 'Example page title' })
    expect(hits[0]?.snippet).toContain('The excerpt text.')
  })
})

describe('Google HTML', () => {
  it('resolves /url links and drops engine navigation', () => {
    const html = `
      <a href="/search?q=other">Other results</a>
      <div><a href="/url?q=https://example.org/article&amp;sa=U&amp;ved=1">Example Org Article</a></div>
      <div class="s">An article excerpt.</div>`
    const hits = specOf('google').parse(html, 'https://www.google.com/search?q=x')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ url: 'https://example.org/article', title: 'Example Org Article' })
    expect(hits[0]?.snippet).toContain('An article excerpt.')
  })
})

describe('Bing HTML', () => {
  it('decodes the base64url destination', () => {
    const target = 'https://example.net/b'
    const encoded = Buffer.from(target, 'utf8').toString('base64url')
    const html = `
      <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${encoded}&amp;ntb=1">Bing Result Title</a></h2><p>Bing excerpt.</p></li>
      <li><a href="https://www.bing.com/images">Images</a></li>`
    const hits = specOf('bing').parse(html, 'https://www.bing.com/search?q=x')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ url: target, title: 'Bing Result Title' })
  })
})

describe('Baidu HTML', () => {
  it('keeps the engine link wrapper and reads the abstract', () => {
    const html = `
      <div class="result c-container)"><h3 class="t"><a href="http://www.baidu.com/link?url=abc">百度结果标题</a></h3>
        <div class="c-abstract">这是摘要内容。</div></div>`
    const hits = specOf('baidu').parse(html, 'https://www.baidu.com/s?wd=x')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.title).toBe('百度结果标题')
    expect(hits[0]?.snippet).toContain('这是摘要内容。')
  })
})

describe('Wikipedia API', () => {
  it('builds article URLs from the search answer', () => {
    const body = JSON.stringify({
      query: {
        search: [
          { title: 'DeepSeek', snippet: '<span class="searchmatch">DeepSeek</span> is a lab.', timestamp: '2026-01-01T00:00:00Z' },
          { title: 'Harness' },
        ],
      },
    })
    const hits = specOf('wikipedia').parse(body, 'https://zh.wikipedia.org/w/api.php')
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({
      url: 'https://zh.wikipedia.org/wiki/DeepSeek',
      title: 'DeepSeek',
      snippet: 'DeepSeek is a lab.',
      publishedAt: '2026-01-01T00:00:00Z',
    })
    expect(hits[1]?.url).toBe('https://zh.wikipedia.org/wiki/Harness')
  })

  it('returns nothing for an HTML block page', () => {
    expect(specOf('wikipedia').parse('<html>blocked</html>', 'https://en.wikipedia.org/w/api.php')).toEqual([])
  })
})

describe('GitHub API', () => {
  it('reads repositories', () => {
    const body = JSON.stringify({
      items: [{ full_name: 'deepseek-ai/DeepSeek-V3', html_url: 'https://github.com/deepseek-ai/DeepSeek-V3', description: 'A model.', pushed_at: '2026-02-02T00:00:00Z' }],
    })
    const hits = specOf('github').parse(body, 'https://api.github.com/search/repositories')
    expect(hits).toEqual([{
      url: 'https://github.com/deepseek-ai/DeepSeek-V3',
      title: 'deepseek-ai/DeepSeek-V3',
      snippet: 'A model.',
      publishedAt: '2026-02-02T00:00:00Z',
    }])
  })
})

describe('Hacker News API', () => {
  it('falls back to the item URL when a story has no link', () => {
    const body = JSON.stringify({
      hits: [
        { title: 'Ask HN: something', url: null, objectID: '42', created_at: '2026-03-03T00:00:00Z' },
        { title: 'A story', url: 'https://example.com/story' },
      ],
    })
    const hits = specOf('hackernews').parse(body, 'https://hn.algolia.com/api/v1/search')
    expect(hits[0]).toMatchObject({ url: 'https://news.ycombinator.com/item?id=42', title: 'Ask HN: something' })
    expect(hits[1]).toMatchObject({ url: 'https://example.com/story' })
  })
})

describe('Stack Exchange API', () => {
  it('reads question tags and creation date', () => {
    const body = JSON.stringify({
      items: [{ title: 'How to fuse rankings?', link: 'https://stackoverflow.com/q/1', tags: ['search', 'rrf'], creation_date: 1767225600 }],
    })
    const hits = specOf('stackexchange').parse(body, 'https://api.stackexchange.com/2.3/search/advanced')
    expect(hits).toEqual([{
      url: 'https://stackoverflow.com/q/1',
      title: 'How to fuse rankings?',
      snippet: 'search rrf',
      publishedAt: '2026-01-01T00:00:00.000Z',
    }])
  })
})

describe('Bilibili API', () => {
  it('strips keyword markup and converts the publish epoch', () => {
    const body = JSON.stringify({
      data: { result: [{ title: '标题<em class="keyword">关键词</em>', arcurl: 'https://www.bilibili.com/video/BV1', description: '简介', pubdate: 1767225600 }] },
    })
    const hits = specOf('bilibili').parse(body, 'https://api.bilibili.com/x/web-interface/search/type')
    expect(hits).toEqual([{
      url: 'https://www.bilibili.com/video/BV1',
      title: '标题 关键词',
      snippet: '简介',
      publishedAt: '2026-01-01T00:00:00.000Z',
    }])
  })
})

describe('Qwant API', () => {
  it('reads web items', () => {
    const body = JSON.stringify({ data: { result: { items: [{ title: 'A result', url: 'https://example.com/q', desc: 'Qwant excerpt' }] } } })
    const hits = specOf('qwant').parse(body, 'https://api.qwant.com/v3/search/web')
    expect(hits).toEqual([{ url: 'https://example.com/q', title: 'A result', snippet: 'Qwant excerpt' }])
  })
})
