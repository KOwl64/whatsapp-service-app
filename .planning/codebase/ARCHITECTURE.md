# Architecture

**Analysis Date:** 2026-01-12

## Pattern Overview

**Overall:** Modular Monolith with Event-Driven Processing Pipeline

**Key Characteristics:**
- Single Express.js server handles all HTTP endpoints
- WhatsApp automation via local browser (whatsapp-web.js)
- Pipeline pattern for POD processing: ingest → normalize → classify → OCR → extract → match → route
- Dual entry points: webhook-only mode (`index.js`) and full automation (`service.js`)
- SQLite for local persistence (no external database)

## Layers

**API/Controller Layer:**
- Purpose: HTTP endpoints and Express route handlers
- Contains: Route definitions, webhook receivers, status endpoints
- Location: `service.js` (lines 464-1475), `index.js`, `status-endpoints.js`
- Depends on: Service layer, models
- Used by: External clients (WhatsApp, admins)

**Service/Business Logic Layer:**
- Purpose: Core pipeline operations for POD processing
- Contains: `classify.js` (POD classification), `ocr.js` (text extraction), `extractor.js` (field parsing), `match.js` (job matching), `autoRoute.js` (routing decisions)
- Depends on: Data access, storage utilities
- Used by: API layer, scheduler

**Data Access Layer:**
- Purpose: Database operations and model management
- Contains: `db.js` (SQLite connection), `models.js` (CRUD operations)
- Depends on: better-sqlite3
- Used by: All layers that need persistence

**Storage Layer:**
- Purpose: File validation, canonical naming, storage paths
- Contains: `normalise.js` (file processing)
- Depends on: fs, path, crypto
- Used by: Service layer during pipeline

**Monitoring/Observability Layer:**
- Purpose: Health checks, metrics, alerting
- Contains: `health.js`, `metrics.js`, `alerts.js`
- Depends on: Database, models
- Used by: Admin API, scheduler

**Governance Layer:**
- Purpose: Compliance features: retention, legal holds, archiving
- Contains: `retention.js`, `legalHold.js`, `archive.js`, `evidence.js`, `audit.js`
- Depends on: Database, storage
- Used by: Scheduler, admin operations

**Scheduling Layer:**
- Purpose: Background job execution
- Contains: `scheduler.js` (cron jobs), `emailQueue.js` (email processing)
- Depends on: All service modules
- Used by: System initialization

**Email Layer:**
- Purpose: Email sending and queue management
- Contains: `email.js`, `emailQueue.js`, `recipients.js`
- Depends on: nodemailer
- Used by: Auto-route decisions, manual exports

## Data Flow

**WhatsApp Message Processing Pipeline:**

```
WhatsApp Message Received
         ↓
    [Ingest] Create message record (models.createMessage)
         ↓
    [Download] Download media from WhatsApp Cloud API
         ↓
    [Normalise] Validate and process file (normalise.js)
                - Calculate content hash
                - Detect file type
                - Generate canonical filename
         ↓
    [Classify] Classify as POD/not-POD (classify.js)
               - Heuristics: size, text patterns
               - Optional AI via Gemini
         ↓
    [OCR] Extract text if POD (ocr.js)
          - Tesseract.js processing
          - In-memory cache by hash
         ↓
    [Extract] Parse fields: job refs, vehicle regs (extractor.js)
              - Regex patterns
         ↓
    [Match] Find matching job (match.js)
            - Multiple sources: API, CSV
            - Confidence scoring
         ↓
    [Route] Decide queue: OUT/REVIEW/QUARANTINE (autoRoute.js)
            - Threshold-based routing
         ↓
    Update attachment status in DB
    Send to email queue if OUT
```

**State Management:**
- SQLite database for persistence
- In-memory caches for OCR results and job cache (no persistence, reset on restart)
- Session state in `.wwebjs_auth/` for WhatsApp

## Key Abstractions

**Module Pattern:**
- Purpose: Each file exports a module object with named functions
- Examples: All `*.js` files follow this pattern
- Pattern: CommonJS exports

**Correlation ID Tracking:**
- Purpose: Track operations across pipeline stages
- Implementation: `audit.js` module with `setCorrelationId()`, `getCorrelationId()`
- Pattern: Thread-local storage via module variable

**Queue Processing:**
- Purpose: Email queue with retry logic
- Implementation: `emailQueue.js` with polling-based processor
- Pattern: Polling with exponential backoff

## Entry Points

**Webhook Mode (`index.js`):**
- Location: `/home/pgooch/whatsapp-service-app/index.js` (15,507 bytes)
- Triggers: HTTP requests from WhatsApp Cloud API
- Responsibilities: Receive webhooks, download media, basic processing

**Full Automation Mode (`service.js`):**
- Location: `/home/pgooch/whatsapp-service-app/service.js` (1,487 lines, 48,919 bytes)
- Triggers: CLI start, WhatsApp events
- Responsibilities: Full WhatsApp automation, all pipeline stages, scheduler

**Queue Processor (`queue-processor.js`):**
- Location: `/home/pgooch/whatsapp-service-app/queue-processor.js` (3,130 bytes)
- Triggers: Standalone process or cron
- Responsibilities: Process pending email queue

## Error Handling

**Strategy:** Try/catch at function boundaries, log errors, continue processing

**Patterns:**
- Service functions catch errors and log via `console.error`
- Audit logging of failed actions via `logFailed()`
- Pipeline continues despite individual stage failures
- No centralized error handling middleware

## Cross-Cutting Concerns

**Logging:**
- Console logging for operational output
- Structured audit logging to SQLite + JSONL files
- Correlation IDs for tracing across stages

**Validation:**
- File type detection via magic numbers in `normalise.js`
- Size limits: `MAX_FILE_SIZE` (configurable)
- Content hash verification

**Audit:**
- Dual-write to SQLite `audit_logs` table and JSONL files
- All pipeline actions logged: INGEST, NORMALISE, CLASSIFY, MATCH, ROUTE, REVIEW, EXPORT

---

*Architecture analysis: 2026-01-12*
*Update when major patterns change*
