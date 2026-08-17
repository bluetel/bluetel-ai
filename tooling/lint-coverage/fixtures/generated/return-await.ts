export const f = async (): Promise<number> => {
  try {
    return Promise.resolve(1)
  } catch {
    return 0
  }
}
