<!--
  Renders agent-written Markdown. Raw HTML is escaped, never rendered: agent output is untrusted, and the
  dashboard has no login, so markup injected here could act for whoever views it.
-->
<script setup lang="ts">
import MarkdownIt from 'markdown-it';
import { computed } from 'vue';

const props = defineProps<{ source: string }>();

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
const defaultLink = markdown.renderer.rules['link_open'];
markdown.renderer.rules['link_open'] = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token?.attrSet('target', '_blank');
  token?.attrSet('rel', 'noopener noreferrer');
  return defaultLink ? defaultLink(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};

const html = computed(() => markdown.render(props.source));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- markdown-it escapes raw HTML (html: false) -->
  <div class="markdown text-sm" v-html="html" />
</template>
