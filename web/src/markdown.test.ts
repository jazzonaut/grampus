// Agent and plan text is untrusted. These replace the legacy client's Markdown tests (test/ui-markdown.test.ts).
import { describe, expect, it } from 'vitest';
import { renderInlineMarkdown, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('formats explanations, nested lists, tables and code', () => {
    const html = renderMarkdown(
      '**Bold** and `code`\n\n- one\n  - nested\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```\nconst x = 1;\n```',
    );
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toMatch(/<ul>\s*<li>one\s*<ul>\s*<li>nested<\/li>/);
    expect(html).toContain('<table>');
    expect(html).toContain('<pre><code>const x = 1;\n</code></pre>');
  });

  it('escapes raw HTML, blocks executable links and never loads images', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[run](javascript:alert(1)) [data](data:text/html,x) [ok](https://example.org)\n\n![tracker](https://example.org/pixel.png)',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/href="(javascript|data):/);
    expect(html).toContain('<a href="https://example.org" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(html).toContain('tracker');
  });
});

describe('renderInlineMarkdown', () => {
  it('keeps emphasis and code but renders no links, so labels never nest interactive elements', () => {
    const html = renderInlineMarkdown('Use **this** `path` [link](https://example.org)');
    expect(html).toContain('<strong>this</strong>');
    expect(html).toContain('<code>path</code>');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<p>');
  });
});
