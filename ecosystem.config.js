module.exports = {
  apps: [{
    name: 'whatsapp-service',
    script: 'service.js',
    cwd: '/home/pgooch/whatsapp-service-app',
    interpreter: 'node',
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    log_file: '/home/pgooch/whatsapp-service-app/pm2.log',
    out_file: '/home/pgooch/whatsapp-service-app/pm2-out.log',
    error_file: '/home/pgooch/whatsapp-service-app/pm2-err.log',
    time: true
  }]
};
