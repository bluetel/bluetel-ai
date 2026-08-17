export const f = (xs: number[]): number => {
  let total = 0
  for (const index in xs) {
    total += Number(index)
  }
  return total
}
