/**
 * Metrics Client - Socket.IO event handler for WhatsApp metrics
 *
 * Event Schema:
 *
 * whatsapp:metrics - Message success/failure metrics
 * {
 *   type: 'metrics',
 *   timestamp: '2026-02-12T10:30:00.000Z',
 *   windows: {
 *     '1m': { success: 5, failure: 0, total: 5, successRate: '100.00' },
 *     '15m': { success: 45, failure: 2, total: 47, successRate: '95.74' },
 *     '1h': { success: 180, failure: 15, total: 195, successRate: '92.31' },
 *     '24h': { success: 4320, failure: 180, total: 4500, successRate: '96.00' }
 *   }
 * }
 *
 * whatsapp:queue - Queue depth statistics
 * {
 *   type: 'queue',
 *   timestamp: '2026-02-12T10:30:00.000Z',
 *   waiting: 12,
 *   active: 3,
 *   completed: 4500,
 *   failed: 180
 * }
 */

class MetricsClient {
  constructor(socket) {
    this.socket = socket;
    this.currentMetrics = null;
    this.currentQueue = null;
    this.listeners = {
      metrics: [],
      queue: [],
      error: [],
      connected: []
    };

    // Set up event handlers
    this.socket.on('whatsapp:metrics', (data) => {
      this.currentMetrics = data;
      this.listeners.metrics.forEach(cb => cb(data));
    });

    this.socket.on('whatsapp:queue', (data) => {
      this.currentQueue = data;
      this.listeners.queue.forEach(cb => cb(data));
    });

    this.socket.on('connect', () => {
      this.listeners.connected.forEach(cb => cb());
    });

    this.socket.on('connect_error', (err) => {
      this.listeners.error.forEach(cb => cb(err));
    });

    this.socket.on('disconnect', () => {
      // Handle disconnect if needed
    });
  }

  /**
   * Register callback for metrics updates
   * @param {Function} callback - Called with metrics data
   * @returns {Function} Unsubscribe function
   */
  onMetrics(callback) {
    this.listeners.metrics.push(callback);
    return () => {
      this.listeners.metrics = this.listeners.metrics.filter(cb => cb !== callback);
    };
  }

  /**
   * Register callback for queue updates
   * @param {Function} callback - Called with queue data
   * @returns {Function} Unsubscribe function
   */
  onQueue(callback) {
    this.listeners.queue.push(callback);
    return () => {
      this.listeners.queue = this.listeners.queue.filter(cb => cb !== callback);
    };
  }

  /**
   * Register callback for connection errors
   * @param {Function} callback - Called with error
   */
  onError(callback) {
    this.listeners.error.push(callback);
  }

  /**
   * Register callback for connection established
   * @param {Function} callback - Called when connected
   */
  onConnected(callback) {
    this.listeners.connected.push(callback);
  }

  /**
   * Get the latest metrics data
   * @returns {Object|null} Latest metrics or null if not yet received
   */
  getMetrics() {
    return this.currentMetrics;
  }

  /**
   * Get the latest queue data
   * @returns {Object|null} Latest queue stats or null if not yet received
   */
  getQueue() {
    return this.currentQueue;
  }

  /**
   * Check if connected to the server
   * @returns {boolean}
   */
  isConnected() {
    return this.socket.connected;
  }

  /**
   * Get success rate for a specific time window
   * @param {string} window - Time window ('1m', '15m', '1h', '24h')
   * @returns {string|null} Success rate as percentage string or null
   */
  getSuccessRate(window) {
    if (!this.currentMetrics || !this.currentMetrics.windows) {
      return null;
    }
    return this.currentMetrics.windows[window]?.successRate || null;
  }

  /**
   * Get total message count for a specific time window
   * @param {string} window - Time window ('1m', '15m', '1h', '24h')
   * @returns {number|null} Total message count or null
   */
  getTotal(window) {
    if (!this.currentMetrics || !this.currentMetrics.windows) {
      return null;
    }
    return this.currentMetrics.windows[window]?.total || 0;
  }

  /**
   * Get failure count for a specific time window
   * @param {string} window - Time window ('1m', '15m', '1h', '24h')
   * @returns {number|null} Failure count or null
   */
  getFailures(window) {
    if (!this.currentMetrics || !this.currentMetrics.windows) {
      return null;
    }
    return this.currentMetrics.windows[window]?.failure || 0;
  }
}

// Export for use in browser
if (typeof window !== 'undefined') {
  window.MetricsClient = MetricsClient;
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MetricsClient;
}
