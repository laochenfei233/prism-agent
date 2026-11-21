/**
 * Progressive enhancement for the design note.
 *
 * The page is complete without this file: it adds the current-section marker in
 * the table of contents and copies code snippets on click. Nothing here renders
 * content, so a disabled script leaves the document intact and readable.
 */

const links = [...document.querySelectorAll('.toc a')];
const sections = links
  .map((link) => document.querySelector(link.getAttribute('href')))
  .filter((section) => section !== null);

if (sections.length > 0 && 'IntersectionObserver' in window) {
  const visible = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.id);
      else visible.delete(entry.target.id);
    }
    const current = [...visible][0];
    for (const link of links) {
      const active = link.getAttribute('href') === `#${current}`;
      link.style.color = active ? 'var(--accent)' : '';
      link.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    }
  }, { rootMargin: '-20% 0px -70% 0px' });
  for (const section of sections) observer.observe(section);
}

for (const code of document.querySelectorAll('code')) {
  const text = code.textContent ?? '';
  if (!/^[\x20-\x7e]+$/.test(text) || text.length < 12) continue;
  code.style.cursor = 'copy';
  code.title = '点击复制';
  code.addEventListener('click', () => {
    navigator.clipboard?.writeText(text).then(() => {
      const previous = code.textContent;
      code.textContent = '已复制';
      setTimeout(() => { code.textContent = previous; }, 900);
    }).catch(() => {});
  });
}
