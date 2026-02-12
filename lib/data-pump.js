// lib/data-pump.js
// Data Pump: Consumes WhatsApp events from Redis and calculates rolling metrics

const Redis = require('ioredis');

// Import failed messages store (Phase 3)
const failedMessages = require('./failed-messages');

class DataPump {
  constructor() {
    this.redis = null;
    this.subscriber = null;
    this.eventChannel = 'whatsapp:events';
    this.metrics = {
      '1m': { success: 0, failure: 0, total: 0 },
      '15m': { success: 0, failure: 0, total: 0 },
      '1h': { success: 0, failure: 0, total: 0 },
      '24h': { success: 0, failure: 0, total: 0 }
    };
    this.windows = {
      '1m': 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000
    };
    this.io = null; // Socket.IO instance for broadcasting
    this.broadcastInterval = null;
    this.broadcastMs = 10000; // 10 seconds
    this.queueStats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0
    };
  }

  async connect() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = new Redis(redisUrl);
    this.subscriber = this.redis.duplicate();

    this.subscriber.on('message', async (channel, message) => {
      await this.processEvent(JSON.parse(message));
    });

    await this.subscriber.subscribe(this.eventChannel);
    console.log('[DATA PUMP] Subscribed to events channel');

    // Start cleanup interval for rolling windows
    this.startCleanupInterval();

    // Initialize metrics from Redis
    await this.recoverMetricsFromRedis();
  }

  setSocketIO(io) {
    this.io = io;
    if (io) {
      this.startBroadcastInterval();
    }
  }

  async recoverMetricsFromRedis() {
    // Recover metrics from Redis sorted sets
    const now = Date.now();
    for (const [window, ms] of Object.entries(this.windows)) {
      const cutoff = now - ms;
      await this.recalculateMetrics(window, cutoff);
    }
    console.log('[DATA PUMP] Metrics recovered from Redis');
  }

  async processEvent(event) {
    const now = Date.now();
    const eventType = event.type;

    // Track message events for success/failure metrics
    if (eventType === 'message.sent' || eventType === 'message.delivered') {
      this.incrementMetric('1m', 'success');
      this.incrementMetric('15m', 'success');
      this.incrementMetric('1h', 'success');
      this.incrementMetric('24h', 'success');
      await this.recordEvent(now, 'success');

      // Record to chart data (Phase 3)
      try {
        const chartData = require('./chart-data');
        await chartData.recordMetrics(1, 0, now);
      } catch (err) {
        // Chart data may not be initialized yet
      }
    } else if (eventType === 'message.failed') {
      this.incrementMetric('1m', 'failure');
      this.incrementMetric('15m', 'failure');
      this.incrementMetric('1h', 'failure');
      this.incrementMetric('24h', 'failure');
      await this.recordEvent(now, 'failure');

      // Record to chart data (Phase 3)
      try {
        const chartData = require('./chart-data');
        await chartData.recordMetrics(0, 1, now);
      } catch (err) {
        // Chart data may not be initialized yet
      }

      // Record to failed messages store (Phase 3)
      try {
        await failedMessages.recordFailure(event);
      } catch (err) {
        // Failed messages store may not be initialized yet
      }
    }

    // Store in rolling window with TTL
    await this.storeInWindow(now, eventType);

    // Broadcast if Socket.IO connected
    if (this.io) {
      this.broadcastMetrics();
    }
  }

  incrementMetric(window, type) {
    this.metrics[window][type]++;
    this.metrics[window].total++;
  }

  async recordEvent(timestamp, result) {
    const key = 'whatsapp:events:window';
    await this.redis.zadd(key, timestamp, JSON.stringify({ timestamp, result }));
    await this.redis.expire(key, 86400); // 24h TTL
  }

  async storeInWindow(timestamp, eventType) {
    const typeKey = `whatsapp:events:type:${eventType}`;
    await this.redis.zadd(typeKey, timestamp, timestamp);
    await this.redis.expire(typeKey, 86400);
  }

  startCleanupInterval() {
    // Clean expired events every 5 minutes
    setInterval(() => this.cleanupWindows(), 5 * 60 * 1000);
    console.log('[DATA PUMP] Cleanup interval started (every 5 minutes)');
  }

  async cleanupWindows() {
    const now = Date.now();
    console.log('[DATA PUMP] Running metrics cleanup...');
    for (const [window, ms] of Object.entries(this.windows)) {
      const cutoff = now - ms;
      await this.recalculateMetrics(window, cutoff);
    }
  }

  async recalculateMetrics(window, cutoff) {
    try {
      const allEvents = await this.redis.zrangebyscore(
        'whatsapp:events:window',
        cutoff,
        '+inf'
      );

      let success = 0, failure = 0;
      for (const eventStr of allEvents) {
        try {
          const event = JSON.parse(eventStr);
          if (event.result === 'success') success++;
          else if (event.result === 'failure') failure++;
        } catch (e) {
          // Skip invalid events
        }
      }

      this.metrics[window] = {
        success,
        failure,
        total: success + failure,
        calculatedAt: Date.now()
      };
    } catch (err) {
      console.error('[DATA PUMP] Recalculate error:', err.message);
    }
  }

  startBroadcastInterval() {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
    }
    this.broadcastInterval = setInterval(() => {
      this.broadcastMetrics();
      this.broadcastQueueStats();
    }, this.broadcastMs);
    console.log('[DATA PUMP] Broadcast interval started (every 10 seconds)');
  }

  broadcastMetrics() {
    if (!this.io) return;

    const rates = this.calculateSuccessRates();
    this.io.emit('whatsapp:metrics', {
      type: 'metrics',
      timestamp: new Date().toISOString(),
      windows: {
        '1m': { ...this.metrics['1m'], successRate: rates['1m'] },
        '15m': { ...this.metrics['15m'], successRate: rates['15m'] },
        '1h': { ...this.metrics['1h'], successRate: rates['1h'] },
        '24h': { ...this.metrics['24h'], successRate: rates['24h'] }
      }
    });
  }

  broadcastQueueStats() {
    if (!this.io) return;

    this.io.emit('whatsapp:queue', {
      type: 'queue',
      timestamp: new Date().toISOString(),
      ...this.queueStats
    });
  }

  calculateSuccessRates() {
    const rates = {};
    for (const [window, data] of Object.entries(this.metrics)) {
      if (data.total > 0) {
        rates[window] = (data.success / data.total * 100).toFixed(2);
      } else {
        rates[window] = '100.00'; // Default to 100% when no data
      }
    }
    return rates;
  }

  async getMetrics() {
    return {
      metrics: this.metrics,
      successRate: this.calculateSuccessRates()
    };
  }

  async getMetricsByWindow(window) {
    const validWindows = ['1m', '15m', '1h', '24h'];
    if (!validWindows.includes(window)) {
      throw new Error(`Invalid window. Valid: ${validWindows.join(', ')}`);
    }
    return {
      window,
      metrics: this.metrics[window],
      successRate: this.calculateSuccessRates()[window]
    };
  }

  updateQueueStats(stats) {
    this.queueStats = { ...this.queueStats, ...stats };
  }

  async getQueueStats() {
    return {
      ...this.queueStats,
      timestamp: new Date().toISOString()
    };
  }

  // For BullMQ queue monitoring
  async initQueueMonitoring(emailQueue) {
    try {
      // Try BullMQ event emitter first
      if (typeof emailQueue.getEventEmitter === 'function') {
        const queueEvents = await emailQueue.getEventEmitter();
        queueEvents.on('waiting', (job) => {
          this.queueStats.waiting++;
        });
        queueEvents.on('completed', (job) => {
          this.queueStats.waiting--;
          this.queueStats.completed++;
        });
        queueEvents.on('failed', (job) => {
          this.queueStats.waiting--;
          this.queueStats.failed++;
        });
        queueEvents.on('active', (job) => {
          this.queueStats.active++;
        });
        queueEvents.on('completed', (job) => {
          this.queueStats.active--;
        });
        console.log('[DATA PUMP] BullMQ queue monitoring initialized');
        return;
      }

      // Fallback: Poll for queue stats using getQueueStats method
      if (typeof emailQueue.getQueueStats === 'function') {
        const pollQueueStats = async () => {
          try {
            const stats = emailQueue.getQueueStats();
            // Map email queue stats to our format
            this.queueStats = {
              waiting: stats.PENDING || 0,
              active: stats.SENDING || 0,
              completed: stats.SENT || 0,
              failed: (stats.FAILED || 0) + (stats.BOUNCED || 0)
            };
          } catch (err) {
            // Ignore polling errors
          }
        };

        // Initial poll
        await pollQueueStats();

        // Start polling interval (every 30 seconds)
        setInterval(pollQueueStats, 30000);
        console.log('[DATA PUMP] Queue polling monitoring initialized');
      }
    } catch (err) {
      console.error('[DATA PUMP] Queue monitoring init error:', err.message);
    }
  }
}

module.exports = new DataPump();
