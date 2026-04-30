export interface CacheStrategy {
  readonly name: string;
  get(id: string): Promise<{ value: string } | null>;
  set(id: string, value: string): Promise<void>;
  /** Write-back only: periodic flush to DB */
  startBackgroundTasks?(): void;
  stopBackgroundTasks?(): void;
}
