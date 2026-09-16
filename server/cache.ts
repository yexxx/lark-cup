import { Redis } from "ioredis";
import { config } from "./config.js";
export class Cache {
  private redis?: Redis;
  private local = new Map<string, { value: string; until: number }>();
  private pending = new Map<string, Promise<any>>();
  constructor(memory = false) {
    if (config.redisUrl && !memory) {
      this.redis = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
      });
      this.redis.on("error", () => {});
    } else if (process.env.NODE_ENV === "production" && !memory)
      throw new Error("REDIS_URL is required in production");
  }
  async ready() {
    if (this.redis && this.redis.status !== "ready")
      await new Promise<void>((resolve, reject) => {
        const ok = () => {
          this.redis!.off("error", bad);
          resolve();
        };
        const bad = (e: Error) => {
          this.redis!.off("ready", ok);
          reject(e);
        };
        this.redis!.once("ready", ok);
        this.redis!.once("error", bad);
      });
  }
  async get(key: string) {
    if (this.redis) return this.redis.get(key);
    const e = this.local.get(key);
    if (e && e.until > Date.now()) return e.value;
    this.local.delete(key);
    return null;
  }
  async set(key: string, value: string, seconds: number) {
    if (this.redis) {
      await this.redis.set(key, value, "EX", seconds);
      return;
    }
    if (this.local.size > 5000) this.local.clear();
    this.local.set(key, { value, until: Date.now() + seconds * 1000 });
  }
  async take(key: string, limit: number, seconds = 60) {
    if (this.redis)
      return (
        Number(
          await this.redis.eval(
            "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
            1,
            `rate:${key}`,
            seconds,
          ),
        ) <= limit
      );
    const k = `rate:${key}`;
    const n = Number((await this.get(k)) || 0) + 1;
    const previous = this.local.get(k);
    this.local.set(k, {
      value: String(n),
      until: previous?.until || Date.now() + seconds * 1000,
    });
    if (this.local.size > 10000)
      for (const [id, e] of this.local)
        if (e.until < Date.now()) this.local.delete(id);
    return n <= limit;
  }
  async cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const value = await this.get(key);
    if (value) return JSON.parse(value);
    if (this.pending.has(key)) return this.pending.get(key);
    const work = fn()
      .then(async (data) => {
        await this.set(key, JSON.stringify(data), ttl);
        return data;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  async close() {
    if (this.redis) await this.redis.quit();
  }
}
