import { createRouter, createWebHashHistory } from 'vue-router';
import BrowserView from '../views/BrowserView.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'sites',
      component: BrowserView,
    },
  ],
});
