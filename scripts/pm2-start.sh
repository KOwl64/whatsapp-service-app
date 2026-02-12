#!/bin/bash
# PM2 Startup Script for WhatsApp Service

set -e

APP_DIR="/home/pgooch/whatsapp-service-app"
ECOSYSTEM="$APP_DIR/ecosystem.config.js"
ENV_FILE="$APP_DIR/.env"

echo "Starting WhatsApp Service with PM2..."

# Load environment variables if .env exists
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Verify Node.js is available
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed"
  exit 1
fi

# Verify application directory exists
if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: Application directory not found: $APP_DIR"
  exit 1
fi

# Install dependencies if needed
if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "Installing npm dependencies..."
  cd "$APP_DIR"
  npm install --production
fi

# Start or restart the application
echo "Deploying via PM2..."
cd "$APP_DIR"

if pm2 list | grep -q "whatsapp-service"; then
  echo "Updating existing deployment..."
  pm2 start "$ECOSYSTEM" --update-env
else
  echo "Starting fresh deployment..."
  pm2 start "$ECOSYSTEM"
fi

# Save PM2 process list for resurrection
pm2 save

# Setup PM2 startup script (if not already configured)
pm2 startup 2>/dev/null || echo "Note: pm2 startup may require sudo"

echo ""
echo "WhatsApp Service Status:"
pm2 list | grep whatsapp-service

echo ""
echo "To view logs: pm2 logs whatsapp-service"
echo "To restart:   pm2 restart whatsapp-service"
