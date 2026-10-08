import { Redis } from "ioredis";
import { config } from "./config.js";
export class Cache {
  private redis?: Redis;
  private local = new Map<string, { value: string; until: number }>();
  private rates = new Map<string, { value: number; until: number }>();
  private pending = new Map<string, Promise<any>>();
  private publicRevision = 0;
  async publicVersion() {
    return this.redis
      ? Number(
          (await this.available(() => this.redis!.get("public:revision"))) || 0,
        )
      : this.publicRevision;
  }
  async invalidatePublic() {
    if (this.redis)
      await this.available(() => this.redis!.incr("public:revision"));
    else this.publicRevision++;
  }
  private async available<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw Object.assign(new Error("缓存服务暂时不可用，请稍后再试"), {
        statusCode: 503,
      });
    }
  }
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
    if (this.redis) return this.available(() => this.redis!.get(key));
    const e = this.local.get(key);
    if (e && e.until > Date.now()) return e.value;
    this.local.delete(key);
    return null;
  }
  async set(key: string, value: string, seconds: number) {
    if (this.redis) {
      await this.available(() => this.redis!.set(key, value, "EX", seconds));
      return;
    }
    if (this.local.size > 5000) this.local.clear();
    this.local.set(key, { value, until: Date.now() + seconds * 1000 });
  }
  async take(key: string, limit: number, seconds = 60) {
    if (this.redis) {
      const n = Number(
        await this.available(() =>
          this.redis!.eval(
            `local time=redis.call('TIME')
local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
local expired=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',now,'LIMIT',0,128)
for _,key in ipairs(expired) do redis.call('HDEL',KEYS[1],key); redis.call('ZREM',KEYS[2],key) end
local untilAt=redis.call('ZSCORE',KEYS[2],ARGV[1])
if not untilAt or tonumber(untilAt)<=now then
 if redis.call('ZCARD',KEYS[2])>=100000 then return -1 end
 redis.call('HSET',KEYS[1],ARGV[1],1)
 redis.call('ZADD',KEYS[2],now+tonumber(ARGV[2])*1000,ARGV[1])
 return 1
end
return redis.call('HINCRBY',KEYS[1],ARGV[1],1)`,
            2,
            "rate:counts",
            "rate:windows",
            key,
            seconds,
          ),
        ),
      );
      return n > 0 && n <= limit;
    }
    const k = `rate:${key}`;
    const entry = this.rates.get(k);
    const previous = entry && entry.until > Date.now() ? entry : undefined;
    const n = (previous?.value || 0) + 1;
    if (!previous && this.rates.size >= 10000) {
      for (const [id, e] of this.rates)
        if (e.until <= Date.now()) this.rates.delete(id);
      if (this.rates.size >= 10000) return false;
    }
    this.rates.set(k, {
      value: n,
      until: previous?.until || Date.now() + seconds * 1000,
    });
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
    if (this.redis)
      await this.redis.quit().catch(() => this.redis!.disconnect());
  }
}
