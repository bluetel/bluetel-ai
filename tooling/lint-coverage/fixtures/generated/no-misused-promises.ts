const check = async (): Promise<boolean> => true

export const f = (): number => {
  if (check()) {
    return 1
  }
  return 0
}
