// lib/failed-messages.js
// Stores and retrieves failed message details for drill-down

const Redis = require('ioredis');

class FailedMessagesStore {
  constructor() {
    this.redis = null;
    this.maxFailures = 1000; // Keep last 1000 failures
  }

  async connect() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = new Redis(redisUrl);
    console.log('[FAILED MESSAGES] Connected');
  }

  async recordFailure(event) {
    const failure = {
      id: event.data?.id || `fail-${Date.now()}`,
      recipient: event.data?.to || 'unknown',
      error: event.data?.error || 'Unknown error',
      errorCode: this.extractErrorCode(event.data?.error),
      timestamp: event.timestamp || new Date().toISOString(),
      senderName: event.data?.senderName || 'unknown',
      retryCount: event.data?.retryCount || 0,
      messageType: event.data?.type || 'unknown'
    };

    // Store in sorted set (score = timestamp)
    const key = 'whatsapp:failures';
    await this.redis.zadd(key, new Date(failure.timestamp).getTime(), JSON.stringify(failure));

    // Trim to max failures
    const count = await this.redis.zcard(key);
    if (count > this.maxFailures) {
      await this.redis.zremrangebyrank(key, 0, count - this.maxFailures - 1);
    }

    // Set TTL
    await this.redis.expire(key, 86400 * 7); // 7 days TTL

    console.log(`[FAILED MESSAGES] Recorded failure for ${failure.recipient}`);
  }

  extractErrorCode(errorMessage) {
    if (!errorMessage) return 'UNKNOWN';

    // Common error patterns
    const patterns = [
      { pattern: /ECONNREFUSED/i, code: 'ECONNREFUSED' },
      { pattern: /ETIMEDOUT|Timeout/i, code: 'TIMEOUT' },
      { pattern: /ENOTFOUND|404/i, code: 'NOT_FOUND' },
      { pattern: /401|Unauthorized/i, code: 'UNAUTHORIZED' },
      { pattern: /403|Forbidden/i, code: 'FORBIDDEN' },
      { pattern: /500|Internal/i, code: 'SERVER_ERROR' },
      { pattern: /429|Rate limit/i, code: 'RATE_LIMIT' },
      { pattern: /network/i, code: 'NETWORK_ERROR' },
      { pattern: /session/i, code: 'SESSION_ERROR' },
      { pattern: /auth/i, code: 'AUTH_ERROR' },
      { pattern: /invalid/i, code: 'INVALID_RECIPIENT' }
    ];

    for (const { pattern, code } of patterns) {
      if (pattern.test(errorMessage)) return code;
    }

    return 'UNKNOWN';
  }

  async getRecentFailures(options = {}) {
    const {
      limit = 50,
      offset = 0,
      errorCode = null,
      recipient = null,
      startTime = null,
      endTime = null
    } = options;

    const key = 'whatsapp:failures';
    let failures = [];

    // Get all failures
    const all = await this.redis.zrevrange(key, offset, offset + limit - 1, 'WITHSCORES');

    for (let i = 0; i < all.length; i += 2) {
      try {
        failures.push(JSON.parse(all[i]));
      } catch (e) {}
    }

    // Apply filters
    if (errorCode) {
      failures = failures.filter(f => f.errorCode === errorCode);
    }
    if (recipient) {
      failures = failures.filter(f => f.recipient && f.recipient.includes(recipient));
    }
    if (startTime) {
      const start = new Date(startTime).getTime();
      failures = failures.filter(f => new Date(f.timestamp).getTime() >= start);
    }
    if (endTime) {
      const end = new Date(endTime).getTime();
      failures = failures.filter(f => new Date(f.timestamp).getTime() <= end);
    }

    // Get total count for pagination
    let total = await this.redis.zcard(key);
    if (errorCode || recipient || startTime || endTime) {
      total = failures.length;
    }

    return {
      failures,
      total,
      limit,
      offset
    };
  }

  async getErrorCodes() {
    const key = 'whatsapp:failures';
    const failures = await this.redis.zrevrange(key, 0, 999);

    const codes = {};
    for (const f of failures) {
      try {
        const parsed = JSON.parse(f);
        codes[parsed.errorCode] = (codes[parsed.errorCode] || 0) + 1;
      } catch (e) {}
    }

    return Object.entries(codes)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count);
  }

  async getFailureStats() {
    const key = 'whatsapp:failures';
    const count = await this.redis.zcard(key);

    const lastHour = Date.now() - (60 * 60 * 1000);
    const recentFailures = await this.redis.zrangebyscore(key, lastHour, '+inf');

    const codes = await this.getErrorCodes();

    return {
      totalFailures: count,
      lastHourCount: recentFailures.length,
      topErrorCodes: codes.slice(0, 5),
      generatedAt: new Date().toISOString()
    };
  }

  async clearFailures() {
    await this.redis.del('whatsapp:failures');
    console.log('[FAILED MESSAGES] Cleared all failures');
  }
}

module.exports = new FailedMessagesStore();
