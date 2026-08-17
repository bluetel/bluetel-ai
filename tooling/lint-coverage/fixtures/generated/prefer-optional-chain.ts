declare const outer: { inner?: { value: number } } | null

export const f = (): unknown => outer && outer.inner && outer.inner.value
