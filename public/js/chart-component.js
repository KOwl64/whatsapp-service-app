/**
 * Line Chart Component - Displays 24h message success/failure trends
 */

class MessageChart {
  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    this.chart = null;
    this.options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 500,
        easing: 'linear'
      },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#eee',
            font: { size: 12 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(22, 33, 62, 0.95)',
          titleColor: '#00d4ff',
          bodyColor: '#eee',
          borderColor: '#0f3460',
          borderWidth: 1,
          padding: 12,
          displayColors: true
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'hour',
            displayFormats: {
              hour: 'HH:mm'
            }
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.1)'
          },
          ticks: {
            color: '#888',
            maxRotation: 0
          }
        },
        y: {
          beginAtZero: true,
          max: 100,
          grid: {
            color: 'rgba(255, 255, 255, 0.1)'
          },
          ticks: {
            color: '#888',
            callback: (value) => value + '%'
          }
        }
      },
      ...options
    };

    this.initChart();
  }

  initChart() {
    // Check if Chart.js is available
    if (typeof Chart === 'undefined') {
      console.error('[CHART] Chart.js not loaded');
      return;
    }

    this.chart = new Chart(this.canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Success Rate',
            data: [],
            borderColor: '#00ff88',
            backgroundColor: 'rgba(0, 255, 136, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: '#00ff88'
          },
          {
            label: 'Failure Rate',
            data: [],
            borderColor: '#ff4757',
            backgroundColor: 'rgba(255, 71, 87, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: '#ff4757'
          }
        ]
      },
      options: this.options
    });
  }

  async loadData(window = '24h') {
    try {
      const response = await fetch(`/api/chart/history/${window}`);
      const result = await response.json();

      if (result.success && result.data) {
        this.updateChart(result.data);
      }
    } catch (err) {
      console.error('[CHART] Failed to load data:', err.message);
    }
  }

  updateChart(data) {
    if (!this.chart) return;

    const labels = data.map(d => new Date(d.timestamp));
    const successRates = data.map(d => parseFloat(d.successRate));
    const failureRates = data.map(d => 100 - parseFloat(d.successRate));

    this.chart.data.labels = labels;
    this.chart.data.datasets[0].data = successRates;
    this.chart.data.datasets[1].data = failureRates;
    this.chart.update('none');
  }

  updateFromSocket(data) {
    // Called from Socket.IO live updates
    // Add single data point and shift if needed
    if (data && data.timestamp) {
      const newLabel = new Date(data.timestamp);
      const newSuccess = parseFloat(data.successRate);
      const newFailure = 100 - newSuccess;

      this.chart.data.labels.push(newLabel);
      this.chart.data.datasets[0].data.push(newSuccess);
      this.chart.data.datasets[1].data.push(newFailure);

      // Keep only last 288 points (24h at 5min intervals)
      const maxPoints = 288;
      if (this.chart.data.labels.length > maxPoints) {
        this.chart.data.labels.shift();
        this.chart.data.datasets[0].data.shift();
        this.chart.data.datasets[1].data.shift();
      }

      this.chart.update('none');
    }
  }

  destroy() {
    if (this.chart) {
      this.chart.destroy();
    }
  }
}

// Export
if (typeof window !== 'undefined') {
  window.MessageChart = MessageChart;
}
