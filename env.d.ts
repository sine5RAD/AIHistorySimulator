/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENCODE_GO_BASE_URL?: string
}

declare module 'mammoth/mammoth.browser' {
  export interface ExtractRawTextResult {
    value: string
  }

  export function extractRawText(options: {
    arrayBuffer: ArrayBuffer
  }): Promise<ExtractRawTextResult>

  const mammoth: {
    extractRawText: typeof extractRawText
  }

  export default mammoth
}
