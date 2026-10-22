// Client-side routes. The server answers unknown paths with index.html, so every route can be reloaded
// or bookmarked.
import { createRouter, createWebHistory } from 'vue-router';
import ComparisonPage from './pages/ComparisonPage.vue';
import ComparisonsPage from './pages/ComparisonsPage.vue';
import EmptyTask from './pages/EmptyTask.vue';
import HelpPage from './pages/HelpPage.vue';
import NewTaskPage from './pages/NewTaskPage.vue';
import RecipesPage from './pages/RecipesPage.vue';
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
    { path: '/new', name: 'new', component: NewTaskPage },
    { path: '/comparisons', name: 'comparisons', component: ComparisonsPage },
    { path: '/comparisons/:id', name: 'comparison', component: ComparisonPage, props: true },
    { path: '/recipes', name: 'recipes', component: RecipesPage },
    { path: '/help', name: 'help', component: HelpPage },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
});
