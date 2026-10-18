// Markdown rendering for agent and plan text, with the same rules as the original dashboard
// (src/ui/markdown.js). Agent text is untrusted, so the output must never carry markup the
// agent wrote.
import MarkdownIt from 'markdown-it';

const options = { html: false, breaks: true, linkify: false, typographer: false } as const;

// html: false escapes every raw HTML tag, so no script, style attribute or event handler can
// reach the page. That is the sanitiser: do not turn it on.
const blocks = new MarkdownIt(options);

// Inline text (buttons, labels) keeps emphasis and code but no links or images, so it never
// nests interactive elements.
const inline = new MarkdownIt(options).disable(['link', 'image', 'autolink']);

const defaultValidateLink = blocks.validateLink.bind(blocks);
blocks.validateLink = (url: string): boolean =>
  defaultValidateLink(url) && (!/^[a-z][a-z\d+.-]*:/i.test(url) || /^(https?:|mailto:)/i.test(url));

blocks.renderer.rules['link_open'] = (tokens, index, settings): string => {
  const token = tokens[index];
  if (token) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return blocks.renderer.renderToken(tokens, index, settings);
};

// Show an image's description instead of fetching an agent-supplied URL.
blocks.renderer.rules['image'] = (tokens, index): string => blocks.utils.escapeHtml(tokens[index]?.content ?? '');

/** Renders block Markdown to safe HTML. */
export function renderMarkdown(text: string): string {
  return blocks.render(text);
}

/** Renders inline Markdown (no links or images) to safe HTML. */
export function renderInlineMarkdown(text: string): string {
  return inline.renderInline(text);
}
