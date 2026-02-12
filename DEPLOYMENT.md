# WhatsApp Service Deployment Checklist

## Pre-Deployment

- [ ] Review changes in CHANGELOG.md
- [ ] Verify all environment variables are set in `.env`
- [ ] Run tests: `npm test`
- [ ] Backup database: `sqlite3 pod.db ".backup backup.db"`
- [ ] Verify Redis is running: `redis-cli ping`

## Deployment Steps

### Option 1: Full Deployment (PM2)

```bash
cd /home/pgooch/whatsapp-service-app

# Pull latest code
git pull origin main

# Install dependencies
npm install --production

# Run verification
./scripts/verify-deployment.sh http://localhost:3000

# Deploy via PM2
pm2 start ecosystem.config.js --update-env

# Verify
./scripts/verify-deployment.sh http://localhost:3000
```

### Option 2: Rolling Restart

```bash
cd /home/pgooch/whatsapp-service-app

# Create backup
cp pod.db backups/pod-$(date +%Y%m%d).db

# Pull changes
git pull

# Restart with zero downtime
pm2 reload whatsapp-service

# Wait and verify
sleep 5
./scripts/verify-deployment.sh http://localhost:3000
```

### Option 3: Quick Restart

```bash
pm2 restart whatsapp-service
sleep 3
pm2 logs --lines 20
```

## Post-Deployment Verification

- [ ] Health endpoint returns 200: `curl http://localhost:3000/health`
- [ ] Dashboard loads: Open `http://localhost:3000/status.html` in browser
- [ ] Authentication required: Verify credentials prompt appears
- [ ] Metrics API works: `curl http://localhost:3000/api/metrics`
- [ ] No errors in logs: `pm2 logs whatsapp-service --lines 50`
- [ ] Process stable: `pm2 monit` (check for stable memory/cpu)

## Rollback Procedure

If issues are detected:

```bash
# Rollback git
git revert HEAD
git push --force  # If needed

# Restore database
sqlite3 pod.db ".restore backups/pod-YYYYMMDD.db"

# Restart previous version
pm2 restart whatsapp-service
```

## Monitoring

### View Logs

```bash
# Real-time logs
pm2 logs whatsapp-service

# Last 100 lines
pm2 logs whatsapp-service --lines 100

# Only errors
pm2 logs whatsapp-service --lines 100 --err
```

### Monitor Resources

```bash
pm2 monit

# Or via API
curl http://localhost:3000/health/details
```

### Set Up Alerts

Configure alerts in monitoring system for:
- `/health` returns 503
- Memory usage > 80%
- Process restarts > 3 in 10 minutes
- Error rate spikes in logs

## Troubleshooting

### Service won't start

```bash
# Check error logs
pm2 logs whatsapp-service --lines 50 --err

# Common issues:
# - Port in use: `lsof -i :3000`
# - Redis not running: `redis-cli ping`
# - Missing env vars: `cat .env`
```

### High memory usage

```bash
# Check memory
pm2 list

# Restart if over limit
pm2 restart whatsapp-service
```

### Authentication issues

```bash
# Verify env vars
pm2 env $(pm2 list | grep whatsapp-service | awk '{print $1}') | grep DASHBOARD

# Restart to apply changes
pm2 restart whatsapp-service
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| NODE_ENV | Yes | production | Environment mode |
| PORT | No | 3000 | HTTP server port |
| REDIS_URL | Yes | redis://localhost:6379 | Redis connection |
| DASHBOARD_USER | Yes | admin | Dashboard username |
| DASHBOARD_PASS | Yes | - | Dashboard password |
| DATABASE_PATH | No | pod.db | SQLite database path |
| STORAGE_BASE_PATH | No | /data/... | POD storage directory |
| ALLOWED_IPS | No | - | Comma-separated IP whitelist |
| IP_WHITELIST_FILE | No | - | Path to IP whitelist file |

## Security Checklist

- [ ] Change default dashboard credentials
- [ ] Use strong password (12+ chars, mixed case, numbers)
- [ ] Enable HTTPS in reverse proxy
- [ ] Restrict access by IP if needed (Nginx allow/deny)
- [ ] Keep dependencies updated: `npm audit`
