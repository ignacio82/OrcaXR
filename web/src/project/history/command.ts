import type { AssetRepository } from '../assets';
import type { DirtyCategory } from '../domain/model';
import type { SelectionStore } from '../selection';
import type { ProjectStore } from '../store';

export interface CommandContext {
  project: ProjectStore;
  selection: SelectionStore;
  assets: AssetRepository;
}

/**
 * Commands own the information needed to apply and revert one mutation. The
 * bus wraps both directions in an atomic project/assets/selection boundary.
 */
export interface ProjectCommand {
  readonly type: string;
  readonly label: string;
  readonly dirtyCategories: readonly DirtyCategory[];
  readonly coalesceKey?: string;
  /** A proven no-op is omitted from dirty state and history entirely. */
  isNoop?(context: CommandContext): boolean;
  apply(context: CommandContext): void;
  revert(context: CommandContext): void;
  mergeWith?(next: ProjectCommand): ProjectCommand | undefined;
  estimateBytes?(): number;
}

export class CompositeProjectCommand implements ProjectCommand {
  readonly type = 'composite';
  readonly dirtyCategories: readonly DirtyCategory[];
  readonly commands: readonly ProjectCommand[];

  constructor(
    readonly label: string,
    commands: readonly ProjectCommand[],
  ) {
    this.commands = [...commands];
    this.dirtyCategories = Array.from(new Set(this.commands.flatMap((command) => command.dirtyCategories)));
  }

  apply(context: CommandContext): void {
    for (const command of this.commands) command.apply(context);
  }

  revert(context: CommandContext): void {
    for (let index = this.commands.length - 1; index >= 0; index -= 1) {
      this.commands[index].revert(context);
    }
  }

  estimateBytes(): number {
    return this.commands.reduce((total, command) => total + Math.max(1, command.estimateBytes?.() ?? 1), 0);
  }
}
