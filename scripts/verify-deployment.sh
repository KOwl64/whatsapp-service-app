#!/bin/bash
# Deployment Verification Script
# Run this after deploying to verify the service is working

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

BASE_URL="${1:-http://localhost:3000}"
PASS=0
FAIL=0

echo "=============================================="
echo "  WhatsApp Service Deployment Verification"
echo "=============================================="
echo "Base URL: $BASE_URL"
echo "Date: $(date)"
echo ""

# Helper function
check_endpoint() {
  local name="$1"
  local url="$2"
  local expected_status="${3:-200}"

  echo -n "Checking: $name... "

  response=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")

  if [ "$response" = "$expected_status" ]; then
    echo -e "${GREEN}PASS${NC} (HTTP $response)"
    ((PASS++))
    return 0
  else
    echo -e "${RED}FAIL${NC} (Expected $expected_status, got $response)"
    ((FAIL++))
    return 1
  fi
}

# Check 1: Health endpoint
check_endpoint "Health Check" "$BASE_URL/health"
check_endpoint "Liveness" "$BASE_URL/health/live"
check_endpoint "Readiness" "$BASE_URL/health/ready"

# Check 2: Public endpoints
check_endpoint "Public Status" "$BASE_URL/api/public/status"

# Check 3: PM2 status
echo ""
echo "Checking PM2 Status..."
if pm2 list | grep -q "whatsapp-service"; then
  status=$(pm2 list | grep whatsapp-service | awk '{print $6}')
  echo -e "  PM2 Status: ${GREEN}RUNNING${NC} ($status)"
  ((PASS++))
else
  echo -e "  ${RED}whatsapp-service not found in PM2${NC}"
  ((FAIL++))
fi

# Check 4: Process resources
echo ""
echo "Resource Usage:"
if pm2 list | grep -q "whatsapp-service"; then
  memory=$(pm2 list | grep whatsapp-service | awk '{print $8}')
  cpu=$(pm2 list | grep whatsapp-service | awk '{print $7}')
  echo "  Memory: $memory"
  echo "  CPU: $cpu"
  ((PASS++))
fi

# Check 5: Recent logs
echo ""
echo "Recent Logs (last 10 lines):"
pm2 logs whatsapp-service --lines 10 --nostream 2>/dev/null | tail -10 || echo "  Unable to fetch logs"

# Check 6: Error count in logs
error_count=$(pm2 logs whatsapp-service --lines 100 --nostream 2>/dev/null | grep -c "ERROR" || echo "0")
if [ "$error_count" -eq 0 ]; then
  echo -e "  Recent Errors: ${GREEN}None${NC}"
else
  echo -e "  Recent Errors: ${YELLOW}$error_count found${NC}"
fi

# Summary
echo ""
echo "=============================================="
echo "  Verification Summary"
echo "=============================================="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}All checks passed!${NC}"
  exit 0
else
  echo -e "${RED}Some checks failed. Review output above.${NC}"
  exit 1
fi
