declare const maybe: string | null

export const f = (): string => maybe || 'fallback'
