# Project Roadmap

**Project:** WhatsApp and POD Pipeline System
**Owner:** Paul Gooch
**Version:** 0.1

---

## Project Vision

Provide a reliable, auditable pipeline that ingests WhatsApp messages and attachments, identifies POD images, matches them to the correct work reference, routes them for review where needed, and distributes outputs to internal and customer recipients with a full audit trail.

---

## Phases

### Phase 1: Foundation
**Status:** Pending | **Research:** Unlikely

Set up core infrastructure, extend existing WhatsApp ingestion service, implement message storage and audit logging foundation.

**Goal:** Working end-to-end pipeline for ingress, normalisation, storage, and audit with manual review capability.

**Scope:**
- Extend `whatsapp-service-app` for POD workflow
- Implement storage structure and file naming
- Add audit logging to all stages
- Create review queue UI (basic)
- Wire up export logging (without auto-send initially)

**Out of Scope:**
- Auto-matching algorithm (Phase 2)
- OCR and field extraction (Phase 2)
- Auto-email distribution (Phase 2)
- Retention policies (Phase 3)

---

### Phase 2: Intelligence
**Status:** Planned | **Research:** Likely

Implement classification, matching algorithm, OCR, and auto-send rules.

**Goal:** High auto-match rate with configurable confidence thresholds.

**Scope:**
- POD classification (is_pod detection)
- OCR for field extraction (job ref, vehicle reg, date)
- Matching against jobs data
- Confidence scoring
- Auto-send rules based on threshold

---

### Phase 3: Distribution
**Status:** Completed | **Research:** Unlikely

Implement email distribution, customer recipient rules, and delivery tracking.

**Goal:** Automated POD delivery to internal and external recipients.

**Scope:**
- Email packaging and sending
- Recipient rules per customer
- Bounce handling and retry logic
- Delivery confirmation tracking

**Completed:**
- Email service with nodemailer
- Customer-specific recipient rules engine
- Database-backed email queue with retry logic
- Bounce handling webhook

---

### Phase 4: Retention & Governance
**Status:** Completed | **Research:** Unlikely

Implement retention policies, legal hold, and archival.

**Goal:** Compliant data lifecycle management with full audit trail.

**Scope:**
- Retention schedule configuration
- Legal hold override
- Archive and delete workflows
- Evidence bundle export

**Completed:**
- Retention policy engine with configurable schedules (365/730/90/2555 day options)
- Legal hold management preventing deletion of protected items
- Archive and restore workflows with tarball storage
- Evidence bundle generator with manifest and checksums
- Full API for retention management

---

### Phase 5: Operations
**Status:** Completed | **Research:** Unlikely

Implement monitoring, alerts, and runbook automation.

**Goal:** Production-ready observability and incident response.

**Scope:**
- Metrics dashboard
- Alert configuration
- Runbook integration
- Health check endpoints

**Completed:**
- Enhanced health checks (BASIC, DEEP, FULL levels)
- Metrics collection (counters, gauges, histograms)
- Alert system with 7 configurable rules and webhook notifications
- Operations dashboard UI with real-time status
- 8 runbook procedures for common issues

---

### Phase 6: Time and Attendance System
**Status:** Pending | **Research:** Likely

Design and implement a Time & Attendance system for driver management, integrated with the existing HRMS.

**Goal:** Digital timesheet capture, attendance tracking, and reporting for the fleet operations team.

**Scope:**
- User authentication for drivers and admins
- Clock-in/clock-out via mobile-friendly interface
- Shift scheduling and overtime tracking
- Absence management (holidays, sickness)
- Integration with HRMS driver data
- Reports: hours worked, attendance summary, anomalies

---

### Phase 7: R2 Cloud File Storage
**Status:** Pending | **Research:** Likely

Implement Cloudflare R2 as the primary object storage backend for all system files.

**Goal:** Secure, durable, and cost-effective file storage with S3-compatible API.

**Scope:**
- Cloudflare R2 bucket configuration
- S3-compatible API integration
- Migration of existing POD files to R2
- File upload/download with signed URLs
- Lifecycle policies (archival, deletion)
- Backup and disaster recovery procedures

---

### Phase 8: Time & Attendance PWA Driver Data Entry
**Status:** Pending | **Research:** Completed (Phase 6)

Build mobile-first PWA for drivers to capture timesheets, clock-in/out, and submit required attendance data.

**Goal:** Offline-capable mobile interface for driver time tracking with geolocation verification.

**Scope:**
- Clock-in/clock-out with GPS verification
- Offline data storage and sync queue
- Shift and break tracking
- Integration with HRMS driver data
- Leave request submission

---

## Domain Expertise

This project requires expertise in:

- **WhatsApp Business API** - Meta's Cloud API for message handling
- **Node.js/Express** - Existing codebase (`whatsapp-service-app`)
- **Python** - Alternative implementation path (`turners-bot`)
- **Image processing** - File validation, hash generation, storage
- **Workflow/Queue systems** - Review routing states
- **Audit logging** - Immutable records for compliance

**Relevant skills:**
- `whatsapp-business` - WhatsApp Business API integration
- `image-processing` - File handling, hash generation
- `workflow-engine` - Queue state management
- `audit-logging` - Compliance trail implementation

---

## Key Decisions Log

| Phase | Decision | Status |
|-------|----------|--------|
| - | Use existing `whatsapp-service-app` as foundation | Pending detail |
| - | Storage target (local filesystem vs S3/cloud) | Pending |
| - | Database for metadata (SQLite vs PostgreSQL) | Pending |
| - | Review UI technology (web vs CLI) | Pending |

---

## Dependencies

- Meta WhatsApp Business API credentials
- Storage backend access
- Jobs/reference data source access

---

## Risks and Concerns

- WhatsApp session management and reconnection
- Storage reliability and backup
- Matching accuracy without customer data access
- Email delivery reliability

---

*Roadmap created: 2026-01-11*
