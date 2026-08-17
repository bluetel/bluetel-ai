declare const loose: any

export const f = (): void => {
  const typed: number = loose
  void typed
}
