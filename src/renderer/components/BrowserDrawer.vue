<script setup lang="ts">
import { Close } from '@icon-park/vue-next';

withDefaults(defineProps<{
  modelValue: boolean;
  title: string;
  width?: string;
}>(), {
  width: '360px',
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();
</script>

<template>
  <aside
    v-if="modelValue"
    class="browser-drawer"
    :style="{ width }"
    role="dialog"
    aria-modal="false"
    :aria-label="title"
  >
    <header class="browser-drawer__header">
      <h2>{{ title }}</h2>
      <button type="button" title="关闭" @click="emit('update:modelValue', false)">
        <Close theme="outline" size="18" />
      </button>
    </header>
    <div class="browser-drawer__body">
      <slot />
    </div>
  </aside>
</template>

<style scoped>
.browser-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 320px;
  max-width: min(460px, 100%);
  background:
    linear-gradient(180deg, rgba(248, 250, 255, 0.96), rgba(250, 251, 255, 0.92)),
    rgba(255, 255, 255, 0.88);
  border-left: 1px solid rgba(188, 199, 224, 0.72);
  box-shadow: -18px 0 48px rgba(52, 64, 108, 0.12);
  backdrop-filter: blur(24px);
}

.browser-drawer__header {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 20px 22px 12px;
  color: #172049;
}

.browser-drawer__header h2 {
  overflow: hidden;
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-drawer__header button {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #667190;
}

.browser-drawer__header button:hover {
  background: rgba(235, 240, 252, 0.8);
  color: #26304d;
}

.browser-drawer__body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 12px 22px 22px;
}
</style>
