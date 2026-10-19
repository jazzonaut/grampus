// Entry point: access token, screen routing, theme, Nuxt UI icons and the root component.
//
// `@nuxt/ui/vue-plugin` is deliberately not installed. Its colour plugin injects a <style>
// element at runtime, which the server's CSP (style-src 'self') blocks; theme/theme.css
// declares the same variables statically. Only the icon registration is installed, so the
// icons bundled at build time render without any request to the Iconify API.
import { createApp } from 'vue';
import icons from '@nuxt/ui/runtime/vue/plugins/icons.js';
import './style.css';
import { bootstrapToken } from './api/client';
import { syncRoute } from './router';
import { followSystemColorScheme } from './theme/colorScheme';
import App from './App.vue';

// The token is taken from the fragment first, so routing never sees it.
bootstrapToken();
syncRoute();
window.addEventListener('hashchange', () => {
  // A fresh startup link pasted into an open tab carries a new token; any other fragment is a screen.
  bootstrapToken();
  syncRoute();
});
followSystemColorScheme();

createApp(App).use(icons).mount('#app');
