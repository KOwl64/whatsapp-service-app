module.exports = {
  apps: [{
    name: 'whatsapp-service',
    script: 'service.js',
    cwd: '/home/pgooch/whatsapp-service-app',
    interpreter: 'node',
    interpreter_args: '--experimental-vm-modules',
    instances: 1,
    exec_mode: 'fork',

    // Restart configuration
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',

    // Exponential backoff restart delay
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 1000,

    // Environment variables
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
      DASHBOARD_USER: process.env.DASHBOARD_USER || 'admin',
      DASHBOARD_PASS: process.env.DASHBOARD_PASS || 'ChangeMe123!'
    },

    env_development: {
      NODE_ENV: 'development',
      PORT: 3000,
      REDIS_URL: 'redis://localhost:6379'
    },

    // Logging configuration
    log_file: '/home/pgooch/whatsapp-service-app/pm2.log',
    out_file: '/home/pgooch/whatsapp-service-app/pm2-out.log',
    error_file: '/home/pgooch/whatsapp-service-app/pm2-err.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,

    // Process identification
    instance_var: 'INSTANCE_ID',

    // Source map support for stack traces
    source_map_support: true,

    // Kill timeout for graceful shutdown
    kill_timeout: 15000,
    listen_timeout: 3000,
    shutdown_with_message: true
  }]
};
