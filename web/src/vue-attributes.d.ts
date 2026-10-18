import type { AriaAttributes } from 'vue';

// strictTemplates rejects attributes a component does not declare as props, but ARIA
// attributes and `role` fall through to the root element, which is how Nuxt UI
// expects them (`<UButton aria-label="Refresh" />`). Allow just those on every component.
declare module 'vue' {
  interface AllowedComponentProps extends AriaAttributes {
    role?: string;
  }
}
