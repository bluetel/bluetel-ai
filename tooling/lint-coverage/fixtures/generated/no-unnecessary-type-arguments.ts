const identity = <T = string,>(value: T): T => value

export const f = (): string => identity<string>('a')
