export const f = (promise: Promise<number>): Promise<number | void> =>
  promise.catch((error: Error) => {
    void error
  })
