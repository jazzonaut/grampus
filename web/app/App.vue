<!-- The app shell: navigation sidebar beside the routed panels. Panel sizes are remembered per browser. -->
<script setup lang="ts">
import AppSidebar from './components/AppSidebar.vue';
</script>

<template>
  <UApp :toaster="{ position: 'bottom-right' }" :tooltip="{ delayDuration: 300 }">
    <UDashboardGroup unit="rem" storage="local" storage-key="grampus-dashboard">
      <AppSidebar />
      <RouterView />
    </UDashboardGroup>
  </UApp>
</template>
