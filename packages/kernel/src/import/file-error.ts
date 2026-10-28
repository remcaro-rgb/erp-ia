const FILE_ERROR = Symbol.for("erp.kernel.ImportFileError");

/** A file that cannot be imported as a whole; `message` is for the user (Spanish). Recognised across module copies, like ProcessError. */
export class ImportFileError extends Error {
  readonly [FILE_ERROR] = true;

  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { [FILE_ERROR]?: unknown })[FILE_ERROR] === true;
  }
}
