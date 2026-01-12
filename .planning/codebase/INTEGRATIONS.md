# External Integrations

**Analysis Date:** 2026-01-12

## APIs & External Services

**WhatsApp Cloud API:**
- Send/receive WhatsApp messages via Meta webhook
- SDK/Client: Custom integration with `whatsapp-web.js` for local browser automation
- Media download: Via Graph API (`graph.facebook.com`)
- Auth: Bearer token in `WHATSAPP_TOKEN` env var
- Webhook verification: `WEBHOOK_VERIFY_TOKEN` env var
- Phone Number ID: `WHATSAPP_PHONE_NUMBER_ID` env var

**Gemini AI (Optional):**
- AI-powered POD classification
- SDK/Client: `@google/generative-ai` package (referenced in code, may need installation)
- Auth: `GEMINI_API_KEY_FREE` env var
- Feature flag: `POD_CLASSIFY_AI_ENABLED` env var (true/false)

**SMTP Email:**
- Send POD confirmation and delivery emails
- SDK/Client: Nodemailer ^7.0.12
- Auth: `SMTP_USER`, `SMTP_PASS` env vars
- Host configuration: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`

## Data Storage

**SQLite:**
- Type/Provider: SQLite with better-sqlite3 driver
- Connection: `SQLITE_DB_PATH` env var (default: `./pod.db`)
- WAL mode enabled for concurrency
- Tables: `messages`, `attachments`, `audit_logs`, `email_queue`, `delivery_log`, `legal_holds`

**File Storage:**
- Local filesystem at `STORAGE_BASE_PATH` or `/data/whatsapp-pod-pods/`
- Hybrid mode with S3 sync capability
- Configuration: `USE_S3_SYNC`, `S3_BUCKET`, `S3_PREFIX` env vars
- S3 implementation is a placeholder (TODO in `normalise.js:255`)

## Authentication & Identity

**WhatsApp Authentication:**
- QR code-based authentication for WhatsApp Web
- Session stored in `.wwebjs_auth/` directory
- Tokens: `WHATSAPP_TOKEN` for Cloud API

## Environment Configuration

**Required Environment Variables:**
```bash
# WhatsApp Cloud API
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WEBHOOK_VERIFY_TOKEN=

# AI Classification (optional)
POD_CLASSIFY_AI_ENABLED=true/false
GEMINI_API_KEY_FREE=

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=false
EMAIL_FROM=
EMAIL_REPLY_TO=
EMAIL_RATE_LIMIT=100

# Storage
STORAGE_BASE_PATH=/data/whatsapp-pod-pods
SQLITE_DB_PATH=./pod.db

# S3 Sync (optional)
USE_S3_SYNC=true/false
S3_BUCKET=pod-files
S3_PREFIX=

# Server
PORT=3000
HOST=0.0.0.0

# Governance
ARCHIVE_PATH=/data/archive
AUDIT_LOG_DIR=/mnt/storage/logs/audit
RETENTION_DAYS=90
```

**Development:**
- Secrets location: External (env vars or 1Password vault)
- Mock/stub services: Not configured

**Production:**
- Secrets management: Environment variables
- Containerized via Docker

## Webhooks & Callbacks

**Incoming:**
- WhatsApp webhook: `/webhook` endpoint in `index.js`
- Verification: `WEBHOOK_VERIFY_TOKEN` for challenge response
- Events: Message types, media attachments

**Outgoing:**
- Email delivery via SMTP
- No webhook integrations configured

---

*Integration audit: 2026-01-12*
*Update when adding/removing external services*
