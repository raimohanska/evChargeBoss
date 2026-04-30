export class IncompleteDataError extends Error {
  readonly missingSlots: Date[];
  constructor(message: string, missingSlots: Date[]) {
    super(message);
    this.name = "IncompleteDataError";
    this.missingSlots = missingSlots;
  }
}
