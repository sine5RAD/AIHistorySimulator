import type { CountryData } from './country'

export interface WorldData {
  countries: CountryData[]
  worldMapImage: string
}

export const createEmptyWorldData = (): WorldData => ({
  countries: [],
  worldMapImage: '',
})

export const emptyWorldDataTemplate: WorldData = createEmptyWorldData()
