export interface MetricsSnapshot {
  cache_hits: number;
  cache_misses: number;
  cache_hit_rate: number | null;
  db_reads: number;
  db_writes: number;
  dirty_keys_current: number;
  dirty_keys_peak: number;
  flush_runs: number;
  keys_flushed_total: number;
}

const state = {
  cache_hits: 0,
  cache_misses: 0,
  db_reads: 0,
  db_writes: 0,
  dirty_keys_current: 0,
  dirty_keys_peak: 0,
  flush_runs: 0,
  keys_flushed_total: 0,
};

export function resetMetrics(): void {
  state.cache_hits = 0;
  state.cache_misses = 0;
  state.db_reads = 0;
  state.db_writes = 0;
  state.dirty_keys_current = 0;
  state.dirty_keys_peak = 0;
  state.flush_runs = 0;
  state.keys_flushed_total = 0;
}

export function incCacheHit(): void {
  state.cache_hits += 1;
}

export function incCacheMiss(): void {
  state.cache_misses += 1;
}

export function incDbRead(n = 1): void {
  state.db_reads += n;
}

export function incDbWrite(n = 1): void {
  state.db_writes += n;
}

export function setDirtyCurrent(n: number): void {
  state.dirty_keys_current = n;
  if (n > state.dirty_keys_peak) state.dirty_keys_peak = n;
}

export function incFlushRun(): void {
  state.flush_runs += 1;
}

export function addKeysFlushed(n: number): void {
  state.keys_flushed_total += n;
}

export function getMetrics(): MetricsSnapshot {
  const denom = state.cache_hits + state.cache_misses;
  return {
    cache_hits: state.cache_hits,
    cache_misses: state.cache_misses,
    cache_hit_rate: denom === 0 ? null : state.cache_hits / denom,
    db_reads: state.db_reads,
    db_writes: state.db_writes,
    dirty_keys_current: state.dirty_keys_current,
    dirty_keys_peak: state.dirty_keys_peak,
    flush_runs: state.flush_runs,
    keys_flushed_total: state.keys_flushed_total,
  };
}
