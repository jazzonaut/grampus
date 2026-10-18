(() => {
  const options = { html: false, breaks: true, linkify: false, typographer: false };
  const blocks = window.markdownit(options);
  // Buttons and labels accept inline formatting without nested interactive elements.
  const inline = window.markdownit(options).disable(['link', 'image', 'autolink']);
  const validateLink = blocks.validateLink;
  blocks.validateLink = url =>
    validateLink(url) && (!/^[a-z][a-z\d+.-]*:/i.test(url) || /^(https?:|mailto:)/i.test(url));
  blocks.renderer.rules.link_open = (tokens, index, settings, environment, renderer) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, settings);
  };
  // Display image descriptions without fetching agent-supplied image URLs.
  blocks.renderer.rules.image = (tokens, index) => blocks.utils.escapeHtml(tokens[index].content);
  window.GrampusMarkdown = Object.freeze({
    render: text => blocks.render(String(text ?? '')),
    inline: text => inline.renderInline(String(text ?? '')),
  });
})();
