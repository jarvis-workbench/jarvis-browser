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
  background: #ffffff;
  border-left: 1px solid #c7cdd4;
  box-shadow: -4px 0 12px rgba(60, 64, 67, 0.12);
}

.browser-drawer__header {
  display: flex;
  min-height: 56px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 10px;
  color: #202124;
}

.browser-drawer__header h2 {
  overflow: hidden;
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-drawer__header button {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #3c4043;
}

.browser-drawer__header button:hover {
  background: #f1f3f4;
}

.browser-drawer__body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 20px;
}
</style>
