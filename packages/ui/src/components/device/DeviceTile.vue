<template>
  <v-card class="device-tile" variant="outlined">
    <v-card-title class="d-flex align-center justify-space-between text-body-2 py-2">
      <span>{{ device.serial }}</span>
      <span v-if="isWsOpen" class="text-caption text-medium-emphasis">
        {{ framesRendered }}fps / skip {{ framesSkipped }}
      </span>
      <span v-else class="text-caption text-medium-emphasis">
        {{ error || 'connecting…' }}
      </span>
    </v-card-title>
    <div class="tile-video" ref="container"></div>
  </v-card>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ScrcpyVideoCodecId } from '@yume-chan/scrcpy'
import { WebCodecsVideoDecoder } from '@yume-chan/scrcpy-decoder-webcodecs'
import { ReadableStream } from '@yume-chan/stream-extra'
import { Unpackr } from 'msgpackr'
import { streamingService } from '@/services/stream/streaming-service'
import { PACK_OPTIONS, DEAULT_BIT_RATE, DEAULT_MAX_FPS } from '@/utils/constants'

const props = defineProps({
  device: { type: Object, required: true },
})

const unpacker = new Unpackr(PACK_OPTIONS)

const container = ref(null)
const isWsOpen = ref(false)
const error = ref('')
const framesRendered = ref(0)
const framesSkipped = ref(0)

let ws
let decoder
let renderer
let abortController
let videoController
let framesInterval

// same h264-preferring pick as adb store's videoEncoders getter, WebCodecs only (grid is view-only, no TinyH264 fallback needed)
const pickVideoEncoder = () => {
  const encoders = props.device.encoders?.filter((e) => e.type === 'video') || []
  return encoders.find((e) => e.codec?.toLowerCase() === 'h264') || encoders[0]
}

const codecIdFor = (codec) => {
  switch (codec) {
    case 'h264':
      return ScrcpyVideoCodecId.H264
    case 'h265':
      return ScrcpyVideoCodecId.H265
    case 'av1':
      return ScrcpyVideoCodecId.AV1
    default:
      return undefined
  }
}

const dispose = async () => {
  if (abortController) {
    abortController.abort()
    abortController = undefined
  }
  if (decoder) {
    await decoder.dispose()
    decoder = undefined
  }
  if (ws) {
    ws.close()
    ws = undefined
  }
  if (framesInterval) {
    clearInterval(framesInterval)
    framesInterval = undefined
  }
  if (container.value) {
    while (container.value.firstChild) {
      container.value.firstChild.remove()
    }
  }
}

const connect = async () => {
  const encoder = pickVideoEncoder()
  const codec = codecIdFor(encoder?.codec)
  if (!encoder || codec === undefined) {
    error.value = 'no video encoder'
    return
  }

  abortController = new AbortController()
  decoder = new WebCodecsVideoDecoder(codec, false)
  renderer = decoder.renderer
  renderer.style.maxWidth = '100%'
  renderer.style.maxHeight = '100%'
  container.value.appendChild(renderer)

  new ReadableStream({
    start(controller) {
      videoController = controller
    },
  })
    .pipeTo(decoder.writable, { signal: abortController.signal })
    .catch(() => {})

  ws = await streamingService.init({
    device: props.device.serial,
    audio: false,
    video: true,
    videoCodec: encoder.codec,
    videoEncoder: encoder.name,
    videoBitRate: DEAULT_BIT_RATE,
    maxFps: DEAULT_MAX_FPS,
    onopen: () => {
      isWsOpen.value = true
    },
    onclose: () => {
      isWsOpen.value = false
    },
    onmessage: (_ws, _id, evt) => {
      const record = unpacker.unpack(evt.data)
      if (record.media === 'video') {
        try {
          videoController.enqueue(record.packet)
        } catch (err) {
          console.log(err)
        }
      }
    },
    onerror: (_ws, _id, evt) => {
      error.value = 'ws error'
      console.log(evt)
    },
  })

  framesInterval = setInterval(() => {
    framesRendered.value = decoder.framesRendered
    framesSkipped.value = decoder.framesSkipped
  }, 1000)
}

onMounted(connect)
onBeforeUnmount(dispose)
</script>

<style scoped>
.device-tile {
  display: flex;
  flex-direction: column;
  background: black;
}
.tile-video {
  aspect-ratio: 9 / 16;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
</style>
