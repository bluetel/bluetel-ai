export class Holder {
  method(): void {
    void this
  }
}

declare const holder: Holder

export const f = (): (() => void) => holder.method
