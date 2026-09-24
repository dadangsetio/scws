<template>
  <v-container fluid>
    <h2 class="text-h5 font-weight-bold mb-4">Device Grid</h2>
    <p v-if="!devices.length" class="text-medium-emphasis">No devices found.</p>
    <div class="grid" v-else>
      <DeviceTile v-for="device in devices" :key="device.serial" :device="device" />
    </div>
  </v-container>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { adbService } from '@/services/adb/adb-service'
import DeviceTile from '@/components/device/DeviceTile.vue'

const devices = ref([])

onMounted(async () => {
  const result = await adbService.metainfo()
  devices.value = result?.data?.devices || []
})
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
</style>
