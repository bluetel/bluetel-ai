declare const loose: any

const takesNumber = (value: number): void => {
  void value
}

export const f = (): void => {
  takesNumber(loose)
}
