import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Everything we need to resume a stream exactly where it stopped. */
export interface CursorState {
  /** Opaque REC paging token returned by the previous `getEvents` call. */
  cursor: string;
  /** Last ledger we have seen, for humans and for metrics. */
  ledger: number;
  /** ISO timestamp of the last successful save. */
  updatedAt: string;
}

/**
 * Where a poller remembers its position. Keyed by a caller-chosen string so one
 * process can run several independent streams (per network, per contract set).
 */
export interface CursorStore {
  load(key: string): Promise<CursorState | null>;
  save(key: string, state: CursorState): Promise<void>;
  clear(key: string): Promise<void>;
}

/** Non-persistent store, for tests and for one-shot `--no-resume` runs. */
export class MemoryCursorStore implements CursorStore {
  readonly #state = new Map<string, CursorState>();
  async load(key: string): Promise<CursorState | null> {
    return this.#state.get(key) ?? null;
  }
  async save(key: string, state: CursorState): Promise<void> {
    this.#state.set(key, state);
  }
  async clear(key: string): Promise<void> {
    this.#state.delete(key);
  }
}

/**
 * JSON-file-backed cursor store. Writes atomically (temp file + rename) so a
 * process killed mid-write resumes from the previous good cursor rather than
 * from a truncated file.
 *
 * Deliberately a flat file and not the SQLite database: Module 1 must be usable
 * on its own, with no storage backend attached.
 */
export class FileCursorStore implements CursorStore {
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(this.#dir, `${safe}.cursor.json`);
  }

  async load(key: string): Promise<CursorState | null> {
    try {
      const text = await readFile(this.#path(key), 'utf8');
      const parsed = JSON.parse(text) as Partial<CursorState>;
      if (typeof parsed.cursor !== 'string' || parsed.cursor === '') return null;
      return {
        cursor: parsed.cursor,
        ledger: typeof parsed.ledger === 'number' ? parsed.ledger : 0,
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(key: string, state: CursorState): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  }

  async clear(key: string): Promise<void> {
    try {
      await writeFile(this.#path(key), '{}\n', 'utf8');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

/**
 * Build a per-chunk cursor key from a base key and a chunk index.
 *
 * When `buildFilters()` splits a contract set across multiple filters, each
 * chunk is polled independently and needs its own cursor. The single-filter
 * path keys the store exactly as before (the bare base key), so existing
 * persisted cursors and the single-contract path are unchanged.
 */
export function chunkCursorKey(baseKey: string, chunkIndex: number, totalChunks: number): string {
  if (totalChunks <= 1) return baseKey;
  return `${baseKey}#chunk-${chunkIndex}-of-${totalChunks}`;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
