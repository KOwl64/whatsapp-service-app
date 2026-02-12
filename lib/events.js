// lib/events.js
const { EventEmitter } = require('events');
const Redis = require('ioredis');
const Bull = require('bullmq');

class WhatsAppEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.redis = null;
    this.publisher = null;
    this.eventChannel = 'whatsapp:events';
    this.isConnected = false;
  }

  async connect() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = new Redis(redisUrl);
    this.publisher = this.redis.duplicate();

    this.redis.on('connect', () => {
      console.log('[EVENTS] Redis connected');
      this.isConnected = true;
    });

    this.redis.on('error', (err) => {
      console.error('[EVENTS] Redis error:', err.message);
      this.isConnected = false;
    });

    // Listen for events and publish to Redis
    this.on('any', async (event) => {
      if (this.isConnected) {
        const payload = {
          type: event.type,
          timestamp: new Date().toISOString(),
          data: event.data,
          metadata: event.metadata || {}
        };
        await this.publisher.publish(this.eventChannel, JSON.stringify(payload));
      }
    });
  }

  emitEvent(type, data, metadata = {}) {
    const event = { type, data, metadata };
    this.emit('any', event);
    this.emit(type, event);
    return event;
  }

  // Convenience methods for connection events
  emitConnectionStatus(status, details = {}) {
    return this.emitEvent('connection.status', {
      status, // 'qr', 'connecting', 'connected', 'disconnected'
      ...details
    });
  }

  emitMessageEvent(type, messageData) {
    return this.emitEvent(`message.${type}`, {
      messageId: messageData.id,
      from: messageData.from,
      hasMedia: messageData.hasMedia,
      timestamp: messageData.timestamp
    });
  }
}

module.exports = new WhatsAppEventEmitter();
