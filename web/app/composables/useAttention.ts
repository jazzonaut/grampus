// Telling the user something needs them while the dashboard is in a background tab: a count in the tab
// title, a dot on the favicon, and (where the browser allows it) a desktop notification for each new
// decision or question. Browsers allow notifications only in a secure context: localhost or HTTPS, so a
// phone on plain http://<address> gets the title and favicon only.
import { computed, ref, watch } from 'vue';
import type { Router } from 'vue-router';
import type { TaskListItem } from '../../../src/dashboard/types';
import { useTasks } from './useTasks';

const iconSize = 64;
const dotRadius = 14;

const supported = typeof Notification !== 'undefined' && window.isSecureContext;
const permission = ref<NotificationPermission>(supported ? Notification.permission : 'denied');

/** A key that changes whenever a task raises a new decision or question. */
function attentionKey(task: TaskListItem): string | null {
  if (task.status !== 'needs-you') return null;
  return `${task.taskId}:${task.needsYou?.since ?? ''}:${task.openQuestions}`;
}

async function drawFavicon(alert: boolean): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (!alert) {
    link.href = '/icon.svg';
    return;
  }
  const image = new Image();
  image.src = '/icon.svg';
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = iconSize;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0, iconSize, iconSize);
  context.beginPath();
  context.arc(iconSize - dotRadius, dotRadius, dotRadius, 0, 2 * Math.PI);
  context.fillStyle = '#f59e0b';
  context.fill();
  link.href = canvas.toDataURL('image/png');
}

export function useAttention(router: Router) {
  const { tasks, loaded } = useTasks();
  const waiting = computed(() => tasks.value.filter(task => task.status === 'needs-you' || task.status === 'stopped'));
  const seen = new Set<string>();
  let primed = false;

  watch(
    () => waiting.value.length,
    count => {
      document.title = count ? `(${count}) Grampus` : 'Grampus';
      void drawFavicon(count > 0);
    },
    { immediate: true },
  );

  watch(tasks, list => {
    if (!loaded.value) return;
    const fresh = list.filter(task => {
      const key = attentionKey(task);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // What already needed the user when the page opened is shown, not announced.
    if (!primed) {
      primed = true;
      return;
    }
    if (permission.value !== 'granted') return;
    for (const task of fresh) {
      const notification = new Notification(`${task.title} needs you`, {
        body: task.needsYou?.detail ?? 'A worker is asking you a question.',
        icon: '/icon-192.png',
        tag: task.taskId,
      });
      notification.onclick = () => {
        window.focus();
        void router.push(`/tasks/${task.taskId}`);
      };
    }
  });
}

/** Whether desktop notifications can be offered here, and a way to ask for them. */
export function useNotificationPermission() {
  return {
    supported,
    permission,
    async request(): Promise<void> {
      if (supported) permission.value = await Notification.requestPermission();
    },
  };
}
