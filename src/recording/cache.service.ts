import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CacheService {
  private readonly client: Redis;
  private readonly logger = new Logger(CacheService.name);

  constructor(private configService: ConfigService) {
    // Initialize Redis client with connection info from config
    this.client = new Redis({
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get('REDIS_PORT', 6379),
      password: this.configService.get('REDIS_PASSWORD', ''),
      db: this.configService.get('REDIS_DB', 0),
      retryStrategy: (times) => {
        // Exponential backoff strategy
        return Math.min(times * 50, 2000);
      }
    });

    this.client.on('error', (err) => {
      this.logger.error('Redis connection error:', err);
    });

    this.client.on('connect', () => {
      this.logger.log('Successfully connected to Redis');
    });
  }

  /**
   * Set a value in the cache with optional expiration
   * @param key Cache key
   * @param value Value to store (will be JSON stringified)
   * @param ttlSeconds Time to live in seconds (optional)
   */
  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value);

      if (ttlSeconds) {
        await this.client.set(key, serializedValue, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, serializedValue);
      }
    } catch (error) {
      this.logger.error(`Error setting cache key ${key}:`, error);
      // Don't rethrow - cache failures shouldn't break the application
    }
  }

  /**
   * Get a value from the cache
   * @param key Cache key
   * @returns Parsed value or null if not found
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);

      if (!value) {
        return null;
      }

      return JSON.parse(value) as T;
    } catch (error) {
      this.logger.error(`Error getting cache key ${key}:`, error);
      return null;
    }
  }

  /**
   * Delete a key from the cache
   * @param key Cache key
   */
  async delete(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.error(`Error deleting cache key ${key}:`, error);
    }
  }

  /**
   * Delete multiple keys matching a pattern
   * @param pattern Key pattern with wildcards (e.g., "user:*")
   */
  async deletePattern(pattern: string): Promise<void> {
    try {
      const keys = await this.client.keys(pattern);

      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } catch (error) {
      this.logger.error(`Error deleting cache keys matching pattern ${pattern}:`, error);
    }
  }

  /**
   * Get a value from cache, or compute and cache it if not found
   * @param key Cache key
   * @param factory Function to compute the value if not in cache
   * @param ttlSeconds Optional TTL in seconds
   */
  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T> {
    const cachedValue = await this.get<T>(key);

    if (cachedValue !== null) {
      return cachedValue;
    }

    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /**
   * Increment a counter in the cache
   * @param key Cache key
   * @param increment Amount to increment (default: 1)
   */
  async increment(key: string, increment = 1): Promise<number> {
    try {
      return await this.client.incrby(key, increment);
    } catch (error) {
      this.logger.error(`Error incrementing cache key ${key}:`, error);
      return 0;
    }
  }

  /**
   * Set a key with expiration only if it doesn't exist (useful for locks)
   * @param key Cache key
   * @param value Value to set
   * @param ttlSeconds TTL in seconds
   * @returns true if the key was set, false if it already existed
   */
  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      return await this.client.set(key, value, 'EX', ttlSeconds, 'NX') === 'OK';
    } catch (error) {
      this.logger.error(`Error setting cache key ${key} with NX:`, error);
      return false;
    }
  }

  /**
   * Acquire a distributed lock
   * @param lockName Name of the lock
   * @param ttlSeconds How long to hold the lock
   * @param maxWaitMs Maximum time to wait for lock in milliseconds
   * @returns Lock identifier string if acquired, null if failed
   */
  async acquireLock(lockName: string, ttlSeconds: number, maxWaitMs = 5000): Promise<string | null> {
    const lockKey = `lock:${lockName}`;
    const lockId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const acquired = await this.setNX(lockKey, lockId, ttlSeconds);

      if (acquired) {
        return lockId;
      }

      // Wait a short time before retrying
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return null; // Failed to acquire lock within the wait time
  }

  /**
   * Release a distributed lock
   * @param lockName Name of the lock
   * @param lockId Lock identifier returned by acquireLock
   * @returns true if released successfully
   */
  async releaseLock(lockName: string, lockId: string): Promise<boolean> {
    const lockKey = `lock:${lockName}`;

    // Only delete the lock if it still has the same value (we own it)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    try {
      const result = await this.client.eval(script, 1, lockKey, lockId);
      return result === 1;
    } catch (error) {
      this.logger.error(`Error releasing lock ${lockName}:`, error);
      return false;
    }
  }
}

// Import Logger class to use logger
import { Logger } from '@nestjs/common';
