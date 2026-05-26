/// <reference types="vite/client" />

declare module 'mammoth/mammoth.browser' {
    export interface ExtractRawTextResult {
        value: string
    }

    export function extractRawText(options: { arrayBuffer: ArrayBuffer }): Promise<ExtractRawTextResult>

    const mammoth: {
        extractRawText: typeof extractRawText
    }

    export default mammoth
}
