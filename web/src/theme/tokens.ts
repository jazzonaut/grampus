// Design tokens shared by the Vite config (Nuxt UI app config) and the status presentation.
// theme.css declares the matching CSS variables; theme.test.ts keeps the two in step.

/**
 * Semantic Nuxt UI colour names and the Tailwind palette each one uses.
 *
 * One calm accent (`primary`), a neutral grey and one colour per kind of status. `reported`
 * marks values a provider reported but Grampus has not verified.
 */
export const paletteColors = {
  primary: 'orange',
  info: 'sky',
  success: 'emerald',
  warning: 'amber',
  error: 'rose',
  reported: 'violet',
  neutral: 'slate',
} as const;

/** A semantic colour usable as a Nuxt UI `color` prop. */
export type SemanticColor = keyof typeof paletteColors;

/** Semantic colours other than `neutral`; Nuxt UI registers these as theme colours. */
export const themeColors = (Object.keys(paletteColors) as SemanticColor[]).filter(color => color !== 'neutral');
