// Dashboard entry point: Nuxt UI, the router and the app shell.
import ui from '@nuxt/ui/vue-plugin';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import './assets/main.css';

createApp(App).use(router).use(ui).mount('#app');
