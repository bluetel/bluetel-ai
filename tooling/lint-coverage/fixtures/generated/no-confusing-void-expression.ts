const returnsVoid = (): void => undefined

export const f = (): void => {
  const captured = returnsVoid()
  void captured
}
