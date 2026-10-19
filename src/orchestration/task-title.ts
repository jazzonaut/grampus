// Owns the provisional name of a planning conversation: a deterministic short title derived from the
// request, shown until the planner's plan supplies `brief.title`. No provider call is spent on naming.
import { serverLimits } from '../config/limits.js';

/** Markdown and markup delimiters that never appear in a displayed title. */
const markupCharacters = '<>`{}[]';
const firstPrintable = 0x20;
const deleteCharacter = 0x7f;
/** Leading Markdown heading, list or quote markers. */
const leadingMarkers = /^(?:[#>*+-]+\s+|\d+[.)]\s+)+/;
/** The end of the first sentence: terminal punctuation followed by whitespace. */
const sentenceEnd = /[.!?](?=\s)/;

/** Replaces control characters and markup delimiters with spaces. */
function plain(text: string): string {
  return [...text]
    .map(char => {
      const code = char.charCodeAt(0);
      return code < firstPrintable || code === deleteCharacter || markupCharacters.includes(char) ? ' ' : char;
    })
    .join('');
}

/**
 * A short title for a request before a plan exists: its first non-empty line, up to the end of the
 * first sentence, without control characters or markup delimiters, with whitespace collapsed, and
 * shortened at a word boundary to `serverLimits.provisionalTitleCharacters`. Returns `null` for a
 * request with no usable text.
 */
export function requestTitle(request: string): string | null {
  const line = request.split(/\r?\n/).find(item => plain(item).trim()) ?? '';
  const end = sentenceEnd.exec(line);
  const text = plain(end ? line.slice(0, end.index) : line)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(leadingMarkers, '')
    .replace(/[.!?:;,]+$/, '');
  if (!text) return null;
  const limit = serverLimits.provisionalTitleCharacters;
  const characters = [...text];
  if (characters.length <= limit) return text;
  const cut = characters.slice(0, limit - 1).join('');
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}
