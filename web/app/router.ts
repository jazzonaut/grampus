// Client-side routes. The server answers unknown paths with index.html, so every route can be reloaded
// or bookmarked.
import { createRouter, createWebHistory } from 'vue-router';
import EmptyTask from './pages/EmptyTask.vue';
import HelpPage from './pages/HelpPage.vue';
import TaskPage from './pages/TaskPage.vue';
import TasksPage from './pages/TasksPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: TasksPage,
      children: [
        { path: '', name: 'tasks', component: EmptyTask },
        { path: 'tasks/:id', name: 'task', component: TaskPage, props: true },
      ],
    },
    { path: '/help', name: 'help', component: HelpPage },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
});
