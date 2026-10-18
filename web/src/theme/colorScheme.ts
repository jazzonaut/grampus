// Light and dark mode. Owns the `dark` class on <html> that Nuxt UI and theme.css key on.

/** The part of `MediaQueryList` the colour scheme needs, so tests can supply their own. */
export interface SchemeQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
}

/**
 * Follows the operating system's `prefers-color-scheme`, live.
 *
 * Nothing is stored and no inline script runs before the bundle: the CSP forbids inline
 * scripts, and the static stylesheet already paints a dark canvas until this applies.
 */
export function followSystemColorScheme(
  root: HTMLElement = document.documentElement,
  query: SchemeQuery = window.matchMedia('(prefers-color-scheme: dark)'),
): void {
  const apply = (dark: boolean): void => {
    root.classList.toggle('dark', dark);
    root.classList.toggle('light', !dark);
  };
  apply(query.matches);
  query.addEventListener('change', event => {
    apply(event.matches);
  });
}
