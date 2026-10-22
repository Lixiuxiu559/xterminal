import { readFile, writeFile, rename, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './certificates.ts';
import type { DeviceRecord, DeviceRepository } from './types.ts';

export function validateDevice(value: unknown): DeviceRecord {
  const record = value as DeviceRecord;
  if (!record || typeof record.id !== 'string' || !record.id || record.id.length > 128 || typeof record.name !== 'string' || record.name.length > 80 ||
      !/^[a-f0-9]{64}$/.test(record.tokenHash) || !Number.isSafeInteger(record.createdAtMs) || !Number.isSafeInteger(record.expiresAtMs) ||
      !(record.revokedAtMs === null || Number.isSafeInteger(record.revokedAtMs))) throw new Error('设备授权存储无效');
  return { id: record.id, name: record.name, tokenHash: record.tokenHash, createdAtMs: record.createdAtMs, expiresAtMs: record.expiresAtMs, revokedAtMs: record.revokedAtMs };
}
/** Default persistence stores hashes only; Host can inject its single-writer SQLite repository. */
export class FileDeviceRepository implements DeviceRepository {
  readonly #dataPath: string;
  #records = new Map<string, DeviceRecord>();
  #loaded?: Promise<void>;
  #writes = Promise.resolve();
  constructor(dataPath: string) { this.#dataPath = dataPath; }
  #load(): Promise<void> {
    return this.#loaded ??= (async () => {
      await privateDirectory(this.#dataPath);
      const file = join(this.#dataPath, 'devices.json');
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('设备授权存储无效');
        await chmod(file, 0o600);
        const values: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!Array.isArray(values) || values.length > 10000) throw new Error('设备授权存储无效');
        for (const value of values) { const record = validateDevice(value); this.#records.set(record.id, record); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    })();
  }
  async list(): Promise<DeviceRecord[]> { await this.#load(); await this.#writes; return [...this.#records.values()].map((record) => ({ ...record })); }
  upsert(device: DeviceRecord): Promise<void> {
    const record = validateDevice(device);
    const write = this.#writes.then(async () => {
      await this.#load();
      if (!this.#records.has(record.id) && this.#records.size >= 10000) throw new Error('设备授权数量超过上限');
      const records = new Map(this.#records); records.set(record.id, record);
      const file = join(this.#dataPath, 'devices.json');
      const temporary = join(this.#dataPath, `devices-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify([...records.values()]), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      this.#records = records;
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}
