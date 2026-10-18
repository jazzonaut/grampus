// Entry point: theme, Nuxt UI icons and the root component.
//
// `@nuxt/ui/vue-plugin` is deliberately not installed. Its colour plugin injects a <style>
// element at runtime, which the server's CSP (style-src 'self') blocks; theme/theme.css
// declares the same variables statically. Only the icon registration is installed, so the
// icons bundled at build time render without any request to the Iconify API.
import { createApp } from 'vue';
import icons from '@nuxt/ui/runtime/vue/plugins/icons.js';
import './style.css';
import { bootstrapToken } from './api/client';
import { followSystemColorScheme } from './theme/colorScheme';
import App from './App.vue';

bootstrapToken();
window.addEventListener('hashchange', () => {
  bootstrapToken();
});
followSystemColorScheme();

createApp(App).use(icons).mount('#app');
