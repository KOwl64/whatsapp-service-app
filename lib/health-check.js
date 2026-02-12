// lib/health-check.js
// Comprehensive health check for load balancers and monitoring

const Redis = require('ioredis');

class HealthCheck {
  constructor() {
    this.redis = null;
    this.startTime = Date.now();
    this.lastCheck = null;
    this.checkHistory = [];
    this.maxHistory = 100;
  }

  async connect() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = new Redis(redisUrl);
    console.log('[HEALTH CHECK] Connected to Redis');
  }

  async performCheck() {
    const check = {
      timestamp: new Date().toISOString(),
      status: 'healthy',
      checks: {},
      duration: 0
    };

    const startTime = Date.now();

    // Check 1: Redis connection
    try {
      if (this.redis) {
        await this.redis.ping();
      }
      check.checks.redis = { status: 'healthy', latency: 0 };
    } catch (err) {
      check.checks.redis = { status: 'unhealthy', error: err.message };
      check.status = 'degraded';
    }

    // Check 2: Memory usage
    const memUsage = process.memoryUsage();
    const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const memLimitMB = 512; // 512MB limit
    const memPercent = Math.round((memUsedMB / memLimitMB) * 100);

    check.checks.memory = {
      status: memPercent < 80 ? 'healthy' : memPercent < 95 ? 'degraded' : 'unhealthy',
      used: `${memUsedMB}MB`,
      limit: `${memLimitMB}MB`,
      percent: `${memPercent}%`
    };

    if (memPercent >= 95) check.status = 'unhealthy';

    // Check 3: Uptime
    const uptimeSeconds = Math.floor(process.uptime());
    check.checks.uptime = {
      status: 'healthy',
      seconds: uptimeSeconds,
      formatted: this.formatDuration(uptimeSeconds)
    };

    // Check 4: Event loop lag
    const lag = await this.checkEventLoopLag();
    check.checks.eventLoop = {
      status: lag < 100 ? 'healthy' : lag < 500 ? 'degraded' : 'unhealthy',
      lagMs: lag
    };

    if (lag >= 500) check.status = 'unhealthy';

    // Check 5: Data Pump connectivity
    try {
      const dataPump = require('./data-pump');
      const metrics = dataPump.getMetrics();
      check.checks.dataPump = {
        status: metrics ? 'healthy' : 'unhealthy',
        lastUpdate: metrics?.timestamp || null
      };
    } catch (err) {
      check.checks.dataPump = { status: 'unhealthy', error: err.message };
      check.status = 'degraded';
    }

    // Calculate duration
    check.duration = Date.now() - startTime;

    // Store in history
    this.checkHistory.push(check);
    if (this.checkHistory.length > this.maxHistory) {
      this.checkHistory.shift();
    }

    this.lastCheck = check;
    return check;
  }

  async checkEventLoopLag() {
    return new Promise((resolve) => {
      const start = Date.now();
      setTimeout(() => {
        resolve(Date.now() - start);
      }, 0);
    });
  }

  formatDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }

  async getHealth() {
    // Return cached result if checked recently
    if (this.lastCheck && (Date.now() - new Date(this.lastCheck.timestamp).getTime()) < 5000) {
      return this.lastCheck;
    }
    return await this.performCheck();
  }

  async getReadiness() {
    const health = await this.getHealth();

    // Readiness check - can this instance handle requests?
    const isReady =
      health.checks.redis.status === 'healthy' &&
      health.checks.memory.status !== 'unhealthy' &&
      health.checks.eventLoop.status !== 'unhealthy';

    return {
      ready: isReady,
      timestamp: health.timestamp,
      reason: isReady ? null : Object.entries(health.checks)
        .filter(([_, v]) => v.status !== 'healthy')
        .map(([k, v]) => `${k}: ${v.status}`)
        .join(', ')
    };
  }

  getLiveness() {
    // Liveness check - is the process running?
    return {
      alive: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      pid: process.pid
    };
  }

  getHistory(hours = 1) {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    return this.checkHistory.filter(c => new Date(c.timestamp).getTime() > cutoff);
  }
}

module.exports = new HealthCheck();
