# Codebase Structure

**Analysis Date:** 2026-01-12

## Directory Layout

```
/home/pgooch/whatsapp-service-app/
├── index.js                          # Webhook entry point (15KB)
├── service.js                        # Main entry point (48KB, 1487 lines)
├── queue-processor.js                # Standalone email queue processor
├── config.js                         # Configuration module
├── db.js                             # SQLite initialization & schema
├── models.js                         # Data access layer (CRUD)
├── normalise.js                      # File validation & storage
├── classify.js                       # POD classification
├── ocr.js                            # OCR text extraction
├── extractor.js                      # Field extraction (regex)
├── match.js                          # Job matching
├── autoRoute.js                      # Routing decisions
├── email.js                          # SMTP email sending
├── emailQueue.js                     # Email queue processing
├── recipients.js                     # Recipient resolution
├── audit.js                          # Audit logging
├── retention.js                      # Retention policies
├── legalHold.js                      # Legal hold management
├── archive.js                        # Archive/restore
├── evidence.js                       # Evidence bundle export
├── scheduler.js                      # Cron job scheduling
├── health.js                         # Health checks
├── metrics.js                        # Metrics collection
├── alerts.js                         # Alerting system
├── runbooks.js                       # Operational runbooks
├── status-endpoints.js               # Status API endpoints
├── package.json                      # Dependencies
├── pod.db                            # SQLite database file
├── Dockerfile                        # Container configuration
├── public/                           # Static assets
├── node_modules/                     # Dependencies
├── .wwebjs_auth/                     # WhatsApp session cache
├── .wwebjs_cache/                    # WhatsApp browser cache
├── test_storage/                     # Test fixtures directory
└── .planning/
    └── codebase/                     # This documentation
```

## Directory Purposes

**Root (`/home/pgooch/whatsapp-service-app/`):**
- Contains all JavaScript source files
- Flat structure - no nested directories for source code
- Entry points at root level

**`public/`:**
- Purpose: Static assets served by Express
- Contains: HTML, CSS, JS for web UI
- Not yet fully populated

**`.wwebjs_auth/`:**
- Purpose: WhatsApp session persistence
- Contains: Encrypted session data
- Auto-created on first run

**`.wwebjs_cache/`:**
- Purpose: WhatsApp browser cache
- Contains: Puppeteer browser data

**`test_storage/`:**
- Purpose: Test fixtures and sample data
- Contains: `logs/`, `metadata/`, `raw/`, `temp/` subdirectories

**`.planning/codebase/`:**
- Purpose: Architecture documentation (this location)
- Contains: STACK.md, ARCHITECTURE.md, STRUCTURE.md, etc.

## Key File Locations

**Entry Points:**
- `index.js` - Webhook-only mode (Meta webhook receiver)
- `service.js` - Full WhatsApp automation with all features
- `queue-processor.js` - Standalone email queue processor

**Configuration:**
- `config.js` - Central configuration with env var overrides
- `package.json` - Dependencies and scripts

**Core Logic:**
- `db.js` - SQLite initialization, schema definition
- `models.js` - Database operations (messages, attachments, audit)
- `audit.js` - Audit logging with correlation IDs
- `classify.js` - POD classification heuristics

**Processing Pipeline:**
- `normalise.js` - File validation, storage paths, canonical naming
- `ocr.js` - Tesseract.js OCR with in-memory cache
- `extractor.js` - Regex-based field extraction (job refs, vehicle regs)
- `match.js` - Job matching from multiple sources
- `autoRoute.js` - Threshold-based routing decisions

**Governance:**
- `retention.js` - Lifecycle management and cleanup
- `legalHold.js` - Legal hold placement and enforcement
- `archive.js` - Cold storage management
- `evidence.js` - Evidence bundle generation

**Email:**
- `email.js` - Nodemailer SMTP transport
- `emailQueue.js` - Queue processing with retry logic
- `recipients.js` - Email recipient resolution

**Monitoring:**
- `health.js` - Health check aggregation
- `metrics.js` - In-memory metrics (counters, gauges, histograms)
- `alerts.js` - Rule-based alerting
- `scheduler.js` - Cron-based background jobs

## Naming Conventions

**Files:**
- kebab-case for all JavaScript files (`service.js`, `emailQueue.js`, `legalHold.js`)
- No PascalCase files (even for modules)
- Test files: None existing

**Functions:**
- camelCase for all functions (`processMediaMessage`, `getAttachmentsByStatus`)

**Variables:**
- camelCase (`contentHash`, `storagePath`, `correlationId`)
- UPPER_SNAKE_CASE for constants (`POD_MIN_SIZE`, `MAX_FILE_SIZE`, `AUDIT_ACTIONS`)

**Database:**
- snake_case for columns (`content_hash`, `job_ref`, `created_at`)
- snake_case plural for tables (`messages`, `attachments`, `audit_logs`)

**Attachment Status Values:**
- UPPER_SNAKE_CASE constants (`REVIEW`, `OUT`, `QUARANTINE`, `ARCHIVED`)

## Where to Add New Code

**New Processing Stage:**
- Implementation: New `*.js` file in root directory
- Imports: Require existing modules as needed
- Exports: Named exports for functions
- Integration: Call from `service.js` pipeline in appropriate location

**New API Endpoint:**
- Implementation: Add to `service.js` or create new file
- Pattern: Express route handler with async function
- Documentation: Update `runbooks.js` if operational impact

**New Background Job:**
- Implementation: Add to `scheduler.js` or create new cron file
- Pattern: node-cron schedule with async function
- Email handling: Integrate with `emailQueue.js` if needed

**New Utility Function:**
- Implementation: Add to existing related module or new file
- Pattern: Pure function with no side effects preferred
- Documentation: JSDoc comments with @param, @returns

## Special Directories

**`.wwebjs_auth/` and `.wwebjs_cache/`:**
- Purpose: WhatsApp Web session and browser cache
- Source: Auto-generated by whatsapp-web.js
- Committed: No (gitignored)

**`test_storage/`:**
- Purpose: Test fixtures and sample data
- Source: Sample POD files and metadata
- Committed: Yes (part of repository)

---

*Structure analysis: 2026-01-12*
*Update when directory structure changes*
