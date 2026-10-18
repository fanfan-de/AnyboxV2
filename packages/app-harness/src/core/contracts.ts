/** A cancellable call separates its business result from actual resource exit. */
export interface OwnedCall<Result> {
  readonly result: Promise<Result>
  /** Requests cancellation; the call may still be cleaning up afterward. */
  cancel(reason: string): void
  /** Settles only after the call and its resources have actually exited. */
  readonly done: Promise<void>
}

export interface RuntimeInputs {
  readonly now: () => string
  readonly newId: () => string
}
