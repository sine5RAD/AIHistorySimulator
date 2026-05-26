import { ref } from 'vue'

export const storageKey = 'timezone-setting'

export const timezoneOptions = [
  -12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
]

export const selectedTimezone = ref(8)

if (typeof window !== 'undefined') {
  const cachedTimezone = window.localStorage.getItem(storageKey)

  if (cachedTimezone && timezoneOptions.includes(Number.parseInt(cachedTimezone, 10))) {
    selectedTimezone.value = Number.parseInt(cachedTimezone, 10)
  }
}

export function formatTimezoneLabel(timezone: number) {
  if (timezone === 0) {
    return '中时区'
  }

  return timezone < 0 ? `西${Math.abs(timezone)}区` : `东${timezone}区`
}