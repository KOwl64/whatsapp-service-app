// lib/chart-data.js
// Maintains 24-hour rolling data points for line chart visualization

const Redis = require('ioredis');

class ChartDataStore {
  constructor() {
    this.redis = null;
    this.localHistory = []; // In-memory cache for fast access
    this.maxDataPoints = 288; // 288 x 5-minute intervals = 24 hours
    this.intervalMs = 5 * 60 * 1000; // 5 minutes
  }

  async connect() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = new Redis(redisUrl);

    // Load existing history from Redis
    await this.loadHistory();

    // Start aggregation interval
    this.startAggregationInterval();

    console.log('[CHART DATA] Connected and initialized');
  }

  async loadHistory() {
    try {
      const data = await this.redis.lrange('whatsapp:chart:history', 0, -1);
      this.localHistory = data.map(JSON.parse);
      console.log(`[CHART DATA] Loaded ${this.localHistory.length} data points`);
    } catch (err) {
      console.error('[CHART DATA] Load error:', err.message);
      this.localHistory = [];
    }
  }

  async recordMetrics(success, failure, timestamp = Date.now()) {
    const bucket = Math.floor(timestamp / this.intervalMs) * this.intervalMs;

    const dataPoint = {
      timestamp: bucket,
      success,
      failure,
      total: success + failure,
      successRate: success + failure > 0
        ? (success / (success + failure) * 100).toFixed(2)
        : 100
    };

    // Add to local history
    this.localHistory.push(dataPoint);

    // Trim to max points
    if (this.localHistory.length > this.maxDataPoints) {
      this.localHistory = this.localHistory.slice(-this.maxDataPoints);
    }

    // Store in Redis for persistence
    await this.redis.lpush('whatsapp:chart:history', JSON.stringify(dataPoint));
    await this.redis.ltrim('whatsapp:chart:history', 0, this.maxDataPoints - 1);
    await this.redis.expire('whatsapp:chart:history', 86400 * 2); // 48h TTL
  }

  startAggregationInterval() {
    setInterval(() => this.aggregateCurrentBucket(), this.intervalMs);
  }

  async aggregateCurrentBucket() {
    // Called every 5 minutes to snapshot current metrics state
    const now = Date.now();
    const bucket = Math.floor(now / this.intervalMs) * this.intervalMs;

    // Get metrics from data pump for this bucket
    const dataPump = require('./data-pump');
    const metrics = dataPump.metrics || { success: 0, failure: 0 };

    await this.recordMetrics(metrics.success, metrics.failure, bucket);
  }

  async getHistory(startTime = null, endTime = null) {
    let filtered = this.localHistory;

    if (startTime) {
      filtered = filtered.filter(d => d.timestamp >= startTime);
    }
    if (endTime) {
      filtered = filtered.filter(d => d.timestamp <= endTime);
    }

    return filtered.sort((a, b) => a.timestamp - b.timestamp);
  }

  async getLast24Hours() {
    const now = Date.now();
    const dayAgo = now - (24 * 60 * 60 * 1000);
    return this.getHistory(dayAgo, now);
  }
}

module.exports = new ChartDataStore();
