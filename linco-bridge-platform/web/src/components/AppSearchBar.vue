<script setup lang="ts">
import { computed } from 'vue'
import { SEARCH_ICON } from '@/constants/search-icons'

const props = withDefaults(
  defineProps<{
    modelValue: string
    hintText?: string
    focus?: boolean
    showClearButton?: boolean
  }>(),
  {
    hintText: '搜索',
    focus: false,
    showClearButton: true,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  focus: []
  confirm: [value: string]
  tap: []
  clear: []
}>()

const hasText = computed(() => props.modelValue.trim().length > 0)

function inputValue(event: Event): string {
  const detailValue = (event as Event & { detail?: { value?: unknown } }).detail?.value
  if (detailValue != null) return String(detailValue)
  return (event.target as HTMLInputElement | null)?.value ?? ''
}

function handleInput(event: Event) {
  emit('update:modelValue', inputValue(event))
}

function handleFocus() {
  emit('focus')
}

function handleConfirm(event: Event) {
  emit('confirm', inputValue(event))
}

function handleTap() {
  emit('tap')
}

function handleClear() {
  emit('update:modelValue', '')
  emit('clear')
}
</script>

<template>
  <view class="app-search-bar" @tap="handleTap">
    <image class="app-search-bar__icon" :src="SEARCH_ICON.loupe" mode="aspectFit" />
    <input
      class="app-search-bar__input"
      type="text"
      :value="modelValue"
      :placeholder="hintText"
      placeholder-class="app-search-bar__placeholder"
      confirm-type="search"
      :focus="focus"
      @input="handleInput"
      @focus="handleFocus"
      @confirm="handleConfirm"
    />
    <view v-if="showClearButton && hasText" class="app-search-bar__clear" @tap.stop="handleClear">
      <text class="app-search-bar__clear-icon">×</text>
    </view>
  </view>
</template>

<style scoped lang="scss">
.app-search-bar {
  display: flex;
  align-items: center;
  height: 80rpx;
  padding: 0 22rpx;
  border-radius: 999rpx;
  background: #f5f5f7;
  box-sizing: border-box;
}

.app-search-bar__icon {
  flex-shrink: 0;
  width: 40rpx;
  height: 40rpx;
  margin-right: 12rpx;
}

.app-search-bar__input {
  flex: 1;
  min-width: 0;
  height: 80rpx;
  font-size: 28rpx;
  line-height: 80rpx;
  color: #1a1a1a;
}

.app-search-bar__clear {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 48rpx;
  height: 48rpx;
  margin-left: 8rpx;
}

.app-search-bar__clear-icon {
  font-size: 36rpx;
  line-height: 1;
  color: #9a948c;
}
</style>

<style lang="scss">
.app-search-bar__placeholder {
  color: #9a948c;
}
</style>
