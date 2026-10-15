import type { CommandClass } from "./catalog";

export interface ClassifiedCommand {
  command: string;
  class: CommandClass;
}

export interface CommandClassifier {
  classify(args: readonly string[]): ClassifiedCommand;
}

export class CommandRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRefusedError";
  }
}
