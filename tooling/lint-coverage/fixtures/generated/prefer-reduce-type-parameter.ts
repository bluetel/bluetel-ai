export const f = (xs: string[]): string[] =>
  xs.reduce((accumulator, item) => [...accumulator, item], [] as string[])
