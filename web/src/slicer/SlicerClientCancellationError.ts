export class SlicerClientCancellationError extends Error {
  readonly outcome: 'cancelled' | 'already-terminal' | 'unconfirmed';
  constructor(
    message: string,
    readonly cancellationConfirmed: boolean,
    readonly terminalStatus?: 'done' | 'error' | 'released',
  ) {
    super(message);
    this.name = 'SlicerClientCancellationError';
    this.outcome = cancellationConfirmed ? 'cancelled' : terminalStatus ? 'already-terminal' : 'unconfirmed';
  }
}
