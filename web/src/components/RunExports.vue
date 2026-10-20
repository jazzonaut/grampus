<script setup lang="ts">
// Owns explicit authenticated downloads; exports are fetched only when requested.
import { ref } from 'vue';
import { download } from '../api/client';
const props = defineProps<{ path: string; name: string }>();
const busy = ref(false),
  error = ref('');
async function save(format: 'json' | 'csv' | 'gzip'): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await download(`${props.path}?format=${format}`, `${props.name}.${format === 'gzip' ? 'json.gz' : format}`);
  } catch (caught) {
    error.value = String(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap gap-4">
      <button :disabled="busy" class="grampus-link" @click="save('json')">Export full JSON</button>
      <button :disabled="busy" class="grampus-link" @click="save('gzip')">Export compressed JSON</button>
      <button :disabled="busy" class="grampus-link" @click="save('csv')">Export metrics CSV</button>
    </div>
    <p v-if="error" role="alert" class="text-error">{{ error }}</p>
  </div>
</template>
