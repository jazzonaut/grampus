<!-- The app shell: navigation sidebar beside the routed panels. Panel sizes are remembered per browser. -->
<script setup lang="ts">
import { useRouter } from 'vue-router';
import AppSidebar from './components/AppSidebar.vue';
import { useAttention } from './composables/useAttention';

useAttention(useRouter());
</script>

<template>
  <UApp :toaster="{ position: 'bottom-right' }" :tooltip="{ delayDuration: 300 }">
    <UDashboardGroup unit="rem" storage="local" storage-key="grampus-dashboard">
      <AppSidebar />
      <RouterView />
    </UDashboardGroup>
  </UApp>
</template>
