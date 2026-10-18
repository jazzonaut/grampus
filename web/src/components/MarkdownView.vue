<script setup lang="ts">
/**
 * MarkdownView: renders discussion, plan and finding text as Markdown.
 *
 * Raw HTML in the source is escaped (markdown-it `html: false`), links open in a new tab
 * without a referrer and only http, https, mailto or relative URLs become links, and images
 * show their description instead of loading. Commands, file contents and expected output
 * should be shown with LogViewer or a code block, not passed through here.
 *
 * Props:
 * - `source`: the Markdown text.
 * - `inline`: render inline only (no paragraphs, links or images), for labels.
 */
import { computed } from 'vue';
import { renderInlineMarkdown, renderMarkdown } from '../markdown';

defineOptions({ name: 'MarkdownView' });

const props = withDefaults(defineProps<{ source: string; inline?: boolean }>(), { inline: false });

const html = computed(() => (props.inline ? renderInlineMarkdown(props.source) : renderMarkdown(props.source)));
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- markdown-it escapes all raw HTML (html: false), see markdown.ts -->
  <span v-if="inline" class="grampus-markdown" v-html="html" />
  <div v-else class="grampus-markdown" v-html="html" />
  <!-- eslint-enable vue/no-v-html -->
</template>
