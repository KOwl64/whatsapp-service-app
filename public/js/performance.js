/**
 * Performance Dashboard JavaScript
 * Real-time metrics display with Chart.js
 */

class PerformanceDashboard {
    constructor() {
        this.refreshInterval = 10000; // 10 seconds
        this.charts = {};
        this.data = {
            metrics: null,
            latency: null,
            alerts: [],
            health: null
        };
        this.init();
    }

    async init() {
        console.log('[PerformanceDashboard] Initializing...');

        // Setup event listeners
        this.setupEventListeners();

        // Load initial data
        await this.refreshAll();

        // Start auto-refresh
        this.startAutoRefresh();

        console.log('[PerformanceDashboard] Initialized');
    }

    setupEventListeners() {
        // Window resize handler
        window.addEventListener('resize', () => {
            this.resizeCharts();
        });

        // Visibility change handler
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.refreshAll();
            }
        });
    }

    async refreshAll() {
        await Promise.all([
            this.fetchMetrics(),
            this.fetchLatency(),
            this.fetchAlerts(),
            this.fetchHealth()
        ]);

        this.updateUI();
        this.updateCharts();
    }

    async fetchMetrics() {
        try {
            const response = await fetch('/api/metrics/system');
            if (response.ok) {
                this.data.metrics = await response.json();
            }
        } catch (err) {
            console.error('[PerformanceDashboard] Failed to fetch metrics:', err.message);
        }
    }

    async fetchLatency() {
        try {
            const response = await fetch('/api/metrics/latency');
            if (response.ok) {
                this.data.latency = await response.json();
            }
        } catch (err) {
            console.error('[PerformanceDashboard] Failed to fetch latency:', err.message);
        }
    }

    async fetchAlerts() {
        try {
            const response = await fetch('/api/metrics/alerts');
            if (response.ok) {
                this.data.alerts = await response.json();
            }
        } catch (err) {
            console.error('[PerformanceDashboard] Failed to fetch alerts:', err.message);
        }
    }

    async fetchHealth() {
        try {
            const response = await fetch('/api/metrics/health');
            if (response.ok) {
                this.data.health = await response.json();
            }
        } catch (err) {
            console.error('[PerformanceDashboard] Failed to fetch health:', err.message);
        }
    }

    updateUI() {
        this.updateStatusBanner();
        this.updateMetricCards();
        this.updateLatencySection();
        this.updateAlertsSection();
        this.updateTimestamp();
    }

    updateStatusBanner() {
        const banner = document.getElementById('status-banner');
        const statusText = document.getElementById('status-text');

        if (!banner || !statusText) return;

        const health = this.data.health;
        if (!health) return;

        banner.className = 'status-banner ' + health.status;
        statusText.textContent = this.formatStatus(health);
    }

    formatStatus(health) {
        const parts = [`Status: ${health.status}`];

        if (health.memory) {
            parts.push(`Memory: ${health.memory.heapUsedMb}MB`);
        }

        if (health.issues && health.issues.length > 0) {
            parts.push(`Issues: ${health.issues.length}`);
        }

        return parts.join(' | ');
    }

    updateMetricCards() {
        const metrics = this.data.metrics;
        if (!metrics) return;

        // Memory Card
        this.updateCard('memory-value', this.formatBytes(metrics.memory?.heapUsed || 0));
        this.updateChange('memory-change', metrics.memory?.change || 0);

        // CPU Card
        this.updateCard('cpu-value', `${metrics.cpu?.avg?.toFixed(1) || 0}%`);
        this.updateChange('cpu-change', metrics.cpu?.change || 0);

        // Latency Card
        this.updateCard('latency-value', `${metrics.latency?.p50 || 0}ms`);
        this.updateChange('latency-change', metrics.latency?.change || 0);

        // Event Loop Card
        this.updateCard('eventloop-value', `${metrics.eventLoopLag?.avg || 0}ms`);

        // Update mini charts
        this.updateMiniCharts(metrics);
    }

    updateCard(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    }

    updateChange(id, change) {
        const element = document.getElementById(id);
        if (!element) return;

        if (change > 0) {
            element.textContent = `+${change.toFixed(1)}%`;
            element.className = 'metric-change negative';
        } else if (change < 0) {
            element.textContent = `${change.toFixed(1)}%`;
            element.className = 'metric-change positive';
        } else {
            element.textContent = '0%';
            element.className = 'metric-change neutral';
        }
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    updateMiniCharts(metrics) {
        // This would update sparkline-style mini charts
        // Placeholder for implementation
    }

    updateLatencySection() {
        const latency = this.data.latency;
        if (!latency) return;

        // Update histogram
        this.renderHistogram(latency.histogram);

        // Update percentiles table
        this.renderPercentiles(latency.percentiles);

        // Update trend
        if (latency.trend) {
            const trendElement = document.getElementById('latency-trend');
            if (trendElement) {
                const trend = latency.trend;
                trendElement.innerHTML = `
                    <span class="trend-indicator ${trend.trend}">
                        ${this.getTrendIcon(trend.trend)}
                        ${trend.trend.charAt(0).toUpperCase() + trend.trend.slice(1)}
                    </span>
                    <span class="trend-value">${trend.changePercent > 0 ? '+' : ''}${trend.changePercent}%</span>
                `;
            }
        }
    }

    renderHistogram(histogram) {
        const container = document.getElementById('histogram-buckets');
        if (!container || !histogram) return;

        const colors = {
            excellent: '#10b981',
            good: '#3b82f6',
            acceptable: '#f59e0b',
            slow: '#f97316',
            verySlow: '#ef4444',
            critical: '#dc2626'
        };

        container.innerHTML = histogram.buckets.map(bucket => {
            const maxPercentage = histogram.buckets.reduce((max, b) => Math.max(max, b.percentage), 0);
            const width = maxPercentage > 0 ? (bucket.percentage / maxPercentage * 100) : 0;

            return `
                <div class="bucket-item">
                    <div class="bucket-label">${bucket.label}</div>
                    <div class="bucket-count" style="color: ${colors[bucket.name] || '#6b7280'}">
                        ${bucket.count.toLocaleString()}
                    </div>
                    <div class="bucket-percentage">${bucket.percentage}%</div>
                    <div class="bucket-bar">
                        <div class="bucket-bar-fill" style="width: ${width}%; background: ${colors[bucket.name] || '#3b82f6'}"></div>
                    </div>
                </div>
            `;
        }).join('');

        // Update total
        const totalElement = document.getElementById('latency-total');
        if (totalElement) {
            totalElement.textContent = histogram.total.toLocaleString();
        }
    }

    renderPercentiles(percentiles) {
        if (!percentiles) return;

        const tableRows = [
            { label: 'P50', value: percentiles.p50 },
            { label: 'P75', value: percentiles.p75 },
            { label: 'P90', value: percentiles.p90 },
            { label: 'P95', value: percentiles.p95 },
            { label: 'P99', value: percentiles.p99 },
            { label: 'P99.9', value: percentiles.p999 },
            { label: 'Min', value: percentiles.min },
            { label: 'Max', value: percentiles.max },
            { label: 'Avg', value: percentiles.avg },
            { label: 'Count', value: percentiles.count }
        ];

        const tableBody = document.getElementById('percentiles-body');
        if (tableBody) {
            tableBody.innerHTML = tableRows.map(row => `
                <tr>
                    <td>${row.label}</td>
                    <td>${typeof row.value === 'number' ? row.value.toLocaleString() : row.value}</td>
                </tr>
            `).join('');
        }
    }

    getTrendIcon(trend) {
        const icons = {
            increasing: '↑',
            decreasing: '↓',
            stable: '→'
        };
        return icons[trend] || icons.stable;
    }

    updateAlertsSection() {
        const alerts = this.data.alerts;
        const container = document.getElementById('alerts-list');

        if (!container) return;

        if (!alerts || alerts.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">✓</div>
                    <div class="empty-state-text">No active alerts</div>
                </div>
            `;
            return;
        }

        container.innerHTML = alerts.map(alert => `
            <div class="alert-item" data-id="${alert.id}">
                <div class="alert-severity ${alert.severity}"></div>
                <div class="alert-content">
                    <div class="alert-message">${alert.message}</div>
                    <div class="alert-time">${this.formatTime(alert.timestamp)}</div>
                </div>
                <div class="alert-actions">
                    <button class="alert-btn acknowledge" onclick="dashboard.acknowledgeAlert('${alert.id}')">
                        Acknowledge
                    </button>
                </div>
            </div>
        `).join('');
    }

    async acknowledgeAlert(alertId) {
        try {
            const response = await fetch(`/api/metrics/alerts/acknowledge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: alertId })
            });

            if (response.ok) {
                // Remove from local display
                this.data.alerts = this.data.alerts.filter(a => a.id !== alertId);
                this.updateAlertsSection();
            }
        } catch (err) {
            console.error('[PerformanceDashboard] Failed to acknowledge alert:', err.message);
        }
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) {
            return 'Just now';
        } else if (diff < 3600000) {
            return `${Math.floor(diff / 60000)}m ago`;
        } else if (diff < 86400000) {
            return `${Math.floor(diff / 3600000)}h ago`;
        } else {
            return date.toLocaleDateString();
        }
    }

    updateTimestamp() {
        const element = document.getElementById('last-updated');
        if (element) {
            element.textContent = new Date().toLocaleTimeString();
        }
    }

    updateCharts() {
        // Chart updates would be implemented here
        // Placeholder for Chart.js integration
    }

    resizeCharts() {
        Object.values(this.charts).forEach(chart => {
            if (chart && chart.resize) {
                chart.resize();
            }
        });
    }

    startAutoRefresh() {
        setInterval(() => {
            this.refreshAll();
        }, this.refreshInterval);
    }
}

// Initialize dashboard when DOM is ready
let dashboard;

document.addEventListener('DOMContentLoaded', () => {
    dashboard = new PerformanceDashboard();
});

// Export for global access
window.PerformanceDashboard = PerformanceDashboard;
window.dashboard = dashboard;
