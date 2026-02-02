/**
 * Runbook Procedures Module
 *
 * Provides operational procedures for common issues:
 * - WHATSAPP_DISCONNECTED: Reconnection steps
 * - QUEUE_BACKLOG: Clear backup steps
 * - EMAIL_FAILURE: SMTP troubleshooting
 * - STORAGE_FULL: Cleanup steps
 * - DATABASE_CORRUPT: Recovery steps
 * - LEGAL_HOLD_EXPIRING: Hold management
 * - SYSTEM_ERROR: General troubleshooting
 *
 * API Endpoints:
 * - GET /api/runbooks - List all runbooks
 * - GET /api/runbooks/:id - Get single runbook
 * - GET /api/runbooks/search/symptom?q=... - Search by symptom
 * - GET /api/runbooks/by-alert/:alertId - Get by alert type
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Runbook definitions
 */
const runbooks = [
    {
        id: 'WHATSAPP_DISCONNECTED',
        title: 'WhatsApp Disconnected',
        severity: 'HIGH',
        category: 'connectivity',
        symptoms: [
            'Client not ready',
            'Messages queuing',
            'QR code displayed continuously',
            'Service status shows disconnected'
        ],
        causes: [
            'Session expired due to phone restart',
            'Network connectivity issue',
            'WhatsApp Web session timeout (30 days)',
            'Browser/Cookie clearing',
            'Phone was logged out remotely'
        ],
        steps: [
            {
                action: 'check',
                description: 'Check network connectivity to the server',
                command: 'ping -c 3 localhost',
                verify: 'Ping successful'
            },
            {
                action: 'restart',
                description: 'Restart the WhatsApp service via PM2',
                command: 'pm2 restart whatsapp-service',
                verify: 'Service status shows "online"'
            },
            {
                action: 'check',
                description: 'Check PM2 logs for authentication errors',
                command: 'pm2 logs whatsapp-service --lines 50',
                verify: 'No authentication errors'
            },
            {
                action: 'scan',
                description: 'If prompted, scan QR code with WhatsApp phone',
                command: 'Access /qr endpoint in browser',
                verify: 'Status shows "Connected"'
            },
            {
                action: 'verify',
                description: 'Verify message processing resumes',
                command: 'pm2 monit',
                verify: 'Messages being processed'
            }
        ],
        prevention: 'Keep WhatsApp Web session active. Avoid clearing browser data. Restart service weekly to refresh session.',
        relatedAlerts: ['whatsapp-disconnected'],
        lastUpdated: '2026-02-02'
    },
    {
        id: 'QUEUE_BACKLOG',
        title: 'Queue Backlog',
        severity: 'MEDIUM',
        category: 'performance',
        symptoms: [
            'Review queue count > 100',
            'Out queue count growing',
            'PODs not being processed',
            'Slow response times'
        ],
        causes: [
            'Manual review bottleneck',
            'OCR service slow or down',
            'Classification errors',
            'Database performance issues',
            'Insufficient resources'
        ],
        steps: [
            {
                action: 'check',
                description: 'Check current queue depths',
                command: 'curl http://localhost:3000/api/queue/stats',
                verify: 'Returns queue statistics'
            },
            {
                action: 'check',
                description: 'Review processing metrics',
                command: 'curl http://localhost:3000/api/metrics/processing',
                verify: 'Throughput and error rate'
            },
            {
                action: 'investigate',
                description: 'Check PM2 logs for errors',
                command: 'pm2 logs whatsapp-service --lines 100 | grep -i error',
                verify: 'Identify specific errors'
            },
            {
                action: 'clear',
                description: 'If stuck items, restart processing',
                command: 'pm2 restart whatsapp-service',
                verify: 'Queue processing resumes'
            },
            {
                action: 'process',
                description: 'Process oldest items first via API',
                command: 'curl "http://localhost:3000/api/queue/review?limit=10&offset=0"',
                verify: 'Returns pending items'
            },
            {
                action: 'alert',
                description: 'If queue > 500, notify team immediately',
                command: 'Contact operations team',
                verify: 'Team acknowledges alert'
            }
        ],
        prevention: 'Monitor queue depths via dashboard. Set up alerts for queue > 100. Review stuck items daily.',
        relatedAlerts: ['review-queue-high'],
        lastUpdated: '2026-02-02'
    },
    {
        id: 'EMAIL_FAILURE',
        title: 'Email Sending Failure',
        severity: 'MEDIUM',
        category: 'email',
        symptoms: [
            'Emails not being sent',
            'Email queue growing',
            'SMTP connection errors',
            'Bounce notifications'
        ],
        causes: [
            'SMTP server down',
            'Authentication credentials expired',
            'Network connectivity to SMTP',
            'Rate limiting by email provider',
            'Invalid recipient addresses'
        ],
        steps: [
            {
                action: 'check',
                description: 'Check email queue status',
                command: 'curl http://localhost:3000/api/email/queue',
                verify: 'Returns queue statistics'
            },
            {
                action: 'check',
                description: 'Review failed email details',
                command: 'curl http://localhost:3000/api/email/status',
                verify: 'Shows error messages'
            },
            {
                action: 'verify',
                description: 'Test SMTP connectivity',
                command: 'nc -zv smtp.example.com 587',
                verify: 'Connection successful'
            },
            {
                action: 'check',
                description: 'Verify SMTP credentials in environment',
                command: 'env | grep SMTP',
                verify: 'Credentials present'
            },
            {
                action: 'retry',
                description: 'Retry failed emails',
                command: 'for id in $(curl -s http://localhost:3000/api/exports?status=FAILED | jq -r ".[0].id"); do curl -X POST "http://localhost:3000/api/email/queue/$id/retry"; done',
                verify: 'Emails requeued'
            },
            {
                action: 'configure',
                description: 'If credentials expired, update environment',
                command: 'Update SMTP_USER and SMTP_PASS in .env',
                verify: 'Credentials updated'
            }
        ],
        prevention: 'Monitor email delivery rates. Set up bounce webhooks. Rotate SMTP credentials monthly.',
        relatedAlerts: ['email-queue-stuck', 'failed-emails-high'],
        lastUpdated: '2026-02-02'
    },
    {
        id: 'STORAGE_FULL',
        title: 'Storage Full',
        severity: 'HIGH',
        category: 'infrastructure',
        symptoms: [
            'Cannot save new PODs',
            'File write errors',
            'Storage low alerts',
            'Database write failures'
        ],
        causes: [
            'Disk partition full',
            'Too many retained files',
            'Archive not running',
            'Log files consuming space'
        ],
        steps: [
            {
                action: 'check',
                description: 'Check disk space usage',
                command: 'df -h /data',
                verify: 'Shows available space'
            },
            {
                action: 'check',
                description: 'Check largest directories',
                command: 'du -sh /data/* | sort -h | tail -10',
                verify: 'Identifies large directories'
            },
            {
                action: 'run',
                description: 'Run retention cleanup (dry run first)',
                command: 'curl -X POST "http://localhost:3000/api/retention/cleanup?dryRun=true"',
                verify: 'Shows items to be cleaned'
            },
            {
                action: 'run',
                description: 'Execute retention cleanup',
                command: 'curl -X POST "http://localhost:300:3000/api/retention/cleanup?dryRun=false"',
                verify: 'Items archived/deleted'
            },
            {
                action: 'check',
                description: 'Check for old logs',
                command: 'ls -lh /home/pgooch/whatsapp-service-app/*.log',
                verify: 'Identify large log files'
            },
            {
                action: 'rotate',
                description: 'Rotate/clear old logs',
                command: 'find /home/pgooch/whatsapp-service-app -name "*.log" -mtime +7 -delete',
                verify: 'Log space freed'
            },
            {
                action: 'monitor',
                description: 'Monitor disk space recovery',
                command: 'watch -n 10 "df -h /data"',
                verify: 'Space increasing'
            }
        ],
        prevention: 'Configure log rotation. Run retention cleanup daily. Monitor disk space with alerts at 20%.',
        relatedAlerts: ['storage-low'],
        lastUpdated: '2026-02-02'
    },
    {
        id: 'DATABASE_CORRUPT',
        title: 'Database Corruption',
        severity: 'CRITICAL',
        category: 'infrastructure',
        symptoms: [
            'Database errors on queries',
            'Cannot read attachments',
            'Audit logs missing',
            'Service crashes on DB access'
        ],
        causes: [
            'Unexpected process termination',
            'Disk write failure',
            'Disk space full during write',
            'Hardware failure',
            'File system corruption'
        ],
        steps: [
            {
                action: 'check',
                description: 'Check database file integrity',
                command: 'sqlite3 /data/whatsapp.db "PRAGMA integrity_check"',
                verify: 'Returns "ok" or errors'
            },
            {
                action: 'backup',
                description: 'Backup current database (even if corrupt)',
                command: 'cp /data/whatsapp.db /data/whatsapp.db.backup',
                verify: 'Backup created'
            },
            {
                action: 'dump',
                description: 'Export data to SQL dump',
                command: 'sqlite3 /data/whatsapp.db .dump > /data/whatsapp_dump.sql',
                verify: 'Dump file created'
            },
            {
                action: 'restore',
                description: 'Create new database from dump',
                command: 'sqlite3 /data/whatsapp.db.new < /data/whatsapp_dump.sql',
                verify: 'New database created'
            },
            {
                action: 'replace',
                description: 'Replace corrupted database',
                command: 'mv /data/whatsapp.db.new /data/whatsapp.db',
                verify: 'New database active'
            },
            {
                action: 'verify',
                description: 'Verify new database works',
                command: 'curl http://localhost:3000/api/queue/stats',
                verify: 'Returns valid data'
            },
            {
                action: 'investigate',
                description: 'Check disk health',
                command: 'smartctl -a /dev/sda',
                verify: 'No disk errors'
            }
        ],
        prevention: 'Enable WAL mode for better reliability. Regular backups. Monitor disk health. Avoid abrupt shutdowns.',
        relatedAlerts: [],
        lastUpdated: '2026-02-02'
    },
    {
        id: 'LEGAL_HOLD_EXPIRING',
        title: 'Legal Hold Expiring',
        severity: 'LOW',
        category: 'compliance',
        symptoms: [
            'Legal hold expiring in 7 days',
            'Compliance alert triggered',
            'Pending hold release review'
        ],
        causes: [
            'Hold was set with expiration date',
            'Ongoing investigation concluded',
            'Routine hold review time'
        ],
        steps: [
            {
                action: 'check',
                description: 'List expiring holds',
                command: 'curl http://localhost:3000/api/legal-holds | jq ".[] | select(.expires_at and (.expires_at | fromdateiso8601 | . < (now + 7*24*60*60)))"',
                verify: 'Shows expiring holds'
            },
            {
                action: 'review',
                description: 'Review each hold with legal team',
                command: 'Contact compliance officer',
                verify: 'Decision documented'
            },
            {
                action: 'extend',
                description: 'If hold needed longer, extend expiration',
                command: 'curl -X POST "http://localhost:3000/api/legal-holds/apply" -H "Content-Type: application/json" -d \'{"attachmentId":"xxx","reason":"Extended by legal","expiresAt":"2026-12-31"}\'',
                verify: 'Hold extended'
            },
            {
                action: 'release',
                description: 'If no longer needed, release hold',
                command: 'curl -X POST "http://localhost:3000/api/legal-holds/{hold_id}/release" -H "Content-Type: application/json" -d \'{"releasedBy":"legal@company.com","releaseReason":"Investigation complete"}\'',
                verify: 'Hold released'
            },
            {
                action: 'audit',
                description: 'Document release decision',
                command: 'Log in audit system',
                verify: 'Audit trail updated'
            }
        ],
        prevention: 'Review holds monthly. Set calendar reminders before expiration. Maintain compliance documentation.',
        relatedAlerts: ['legal-holds-expiring'],
        lastUpdated: '2026-02-02'
    },
    {
        id: 'SYSTEM_ERROR',
        title: 'System Error',
        severity: 'MEDIUM',
        category: 'general',
        symptoms: [
            'High error rate detected',
            'Processing failures',
            'Service instability',
            'Unusual error messages'
        ],
        causes: [
            'Code bug triggered',
            'External dependency failure',
            'Resource exhaustion',
            'Configuration issue',
            'Memory leak'
        ],
        steps: [
            {
                action: 'check',
                description: 'Check recent error logs',
                command: 'pm2 logs whatsapp-service --lines 100 | grep -A2 -i error',
                verify: 'Identify error patterns'
            },
            {
                action: 'check',
                description: 'Monitor resource usage',
                command: 'pm2 monit',
                verify: 'CPU, memory, network'
            },
            {
                action: 'restart',
                description: 'Restart service to clear transient errors',
                command: 'pm2 restart whatsapp-service',
                verify: 'Service restarts cleanly'
            },
            {
                action: 'check',
                description: 'Verify error rate decreased',
                command: 'curl http://localhost:3000/api/alerts/stats',
                verify: 'Error count reduced'
            },
            {
                action: 'investigate',
                description: 'If errors persist, check dependencies',
                command: 'curl http://localhost:3000/health?level=deep',
                verify: 'All checks healthy'
            },
            {
                action: 'rollback',
                description: 'If recent deployment caused issues, rollback',
                command: 'git checkout previous_version && pm2 restart whatsapp-service',
                verify: 'Previous version running'
            }
        ],
        prevention: 'Implement comprehensive logging. Set up error rate alerts. Use feature flags for risky changes.',
        relatedAlerts: ['error-rate-spike'],
        lastUpdated: '2026-02-02'
    },
    {
        id: 'OCR_SERVICE_DOWN',
        title: 'OCR Service Down',
        severity: 'MEDIUM',
        category: 'processing',
        symptoms: [
            'OCR not extracting text',
            'Classification fails for PODs',
            'No OCR confidence scores',
            'Processing times increase'
        ],
        causes: [
            'OCR library crash',
            'Memory exhausted',
            'Invalid image format',
            'Corrupted Tesseract data'
        ],
        steps: [
            {
                action: 'check',
                description: 'Test OCR on sample image',
                command: 'curl -X POST "http://localhost:3000/api/classify/test" -F "image=@test.jpg"',
                verify: 'Returns classification'
            },
            {
                action: 'restart',
                description: 'Restart service to reload OCR',
                command: 'pm2 restart whatsapp-service',
                verify: 'Service restarts'
            },
            {
                action: 'check',
                description: 'Verify Tesseract installation',
                command: 'tesseract --version',
                verify: 'Tesseract available'
            },
            {
                action: 'configure',
                description: 'Check OCR configuration',
                command: 'grep -r "OCR" config/',
                verify: 'Config is correct'
            },
            {
                action: 'bypass',
                description: 'If urgent, route PODs manually until fixed',
                command: 'Process via admin panel',
                verify: 'Manual processing works'
            }
        ],
        prevention: 'Monitor OCR success rate. Keep Tesseract data updated. Add fallback classification.',
        relatedAlerts: ['error-rate-spike'],
        lastUpdated: '2026-02-02'
    }
];

/**
 * In-memory index for searching
 */
const symptomIndex = new Map();
const categoryIndex = new Map();
const alertIndex = new Map();

/**
 * Build search indexes
 */
function buildIndexes() {
    runbooks.forEach(runbook => {
        // Index symptoms
        runbook.symptoms.forEach(symptom => {
            const key = symptom.toLowerCase();
            if (!symptomIndex.has(key)) {
                symptomIndex.set(key, []);
            }
            symptomIndex.get(key).push(runbook.id);
        });

        // Index categories
        if (!categoryIndex.has(runbook.category)) {
            categoryIndex.set(runbook.category, []);
        }
        categoryIndex.get(runbook.category).push(runbook.id);

        // Index related alerts
        runbook.relatedAlerts.forEach(alertId => {
            if (!alertIndex.has(alertId)) {
                alertIndex.set(alertId, []);
            }
            alertIndex.get(alertId).push(runbook.id);
        });
    });
}

buildIndexes();

/**
 * Initialize module
 */
function init() {
    console.log(`[Runbooks] Module initialized with ${runbooks.length} runbooks`);
}

/**
 * List all runbooks with optional filtering
 */
function list({ severity = null, category = null, search = null } = {}) {
    let result = runbooks;

    if (severity) {
        result = result.filter(r => r.severity.toLowerCase() === severity.toLowerCase());
    }

    if (category) {
        result = result.filter(r => r.category.toLowerCase() === category.toLowerCase());
    }

    if (search) {
        const searchLower = search.toLowerCase();
        result = result.filter(r =>
            r.title.toLowerCase().includes(searchLower) ||
            r.symptoms.some(s => s.toLowerCase().includes(searchLower)) ||
            r.causes.some(c => c.toLowerCase().includes(searchLower))
        );
    }

    return {
        count: result.length,
        runbooks: result.map(r => ({
            id: r.id,
            title: r.title,
            severity: r.severity,
            category: r.category,
            symptoms: r.symptoms.slice(0, 3) // First 3 symptoms for preview
        }))
    };
}

/**
 * Get single runbook by ID
 */
function get(id) {
    const runbook = runbooks.find(r => r.id === id);
    if (!runbook) return null;

    return {
        id: runbook.id,
        title: runbook.title,
        severity: runbook.severity,
        category: runbook.category,
        symptoms: runbook.symptoms,
        causes: runbook.causes,
        steps: runbook.steps,
        prevention: runbook.prevention,
        relatedAlerts: runbook.relatedAlerts,
        lastUpdated: runbook.lastUpdated
    };
}

/**
 * Search runbooks by symptom
 */
function searchBySymptom(query) {
    if (!query) return { count: 0, runbooks: [] };

    const results = [];
    const queryLower = query.toLowerCase();

    runbooks.forEach(runbook => {
        // Check exact symptom matches
        runbook.symptoms.forEach(symptom => {
            if (symptom.toLowerCase().includes(queryLower)) {
                if (!results.find(r => r.id === runbook.id)) {
                    results.push({
                        id: runbook.id,
                        title: runbook.title,
                        severity: runbook.severity,
                        matchedSymptom: symptom,
                        matchType: 'symptom'
                    });
                }
            }
        });

        // Check title matches
        if (runbook.title.toLowerCase().includes(queryLower)) {
            if (!results.find(r => r.id === runbook.id)) {
                results.push({
                    id: runbook.id,
                    title: runbook.title,
                    severity: runbook.severity,
                    matchedSymptom: runbook.symptoms[0],
                    matchType: 'title'
                });
            }
        }
    });

    return {
        query,
        count: results.length,
        runbooks: results
    };
}

/**
 * Get runbooks related to an alert
 */
function getByAlert(alertId) {
    const runbookIds = alertIndex.get(alertId) || [];
    return runbookIds.map(id => get(id)).filter(Boolean);
}

/**
 * Get runbooks by category
 */
function getByCategory(category) {
    const runbookIds = categoryIndex.get(category.toLowerCase()) || [];
    return runbookIds.map(id => get(id)).filter(Boolean);
}

/**
 * Get severity levels
 */
function getSeverityLevels() {
    return ['HIGH', 'MEDIUM', 'LOW'].map(level => ({
        value: level,
        count: runbooks.filter(r => r.severity === level).length
    }));
}

/**
 * Get quick reference (summary)
 */
function getQuickReference() {
    return runbooks.map(r => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        firstStep: r.steps[0]?.description || 'N/A'
    }));
}

/**
 * Export runbook as markdown
 */
function exportAsMarkdown(id) {
    const runbook = get(id);
    if (!runbook) return null;

    let md = `# ${runbook.id}: ${runbook.title}\n\n`;
    md += `**Severity:** ${runbook.severity} | **Category:** ${runbook.category}\n\n`;
    md += `**Last Updated:** ${runbook.lastUpdated}\n\n`;

    md += `## Symptoms\n\n`;
    runbook.symptoms.forEach(s => md += `- ${s}\n`);
    md += `\n`;

    md += `## Causes\n\n`;
    runbook.causes.forEach(c => md += `- ${c}\n`);
    md += `\n`;

    md += `## Resolution Steps\n\n`;
    runbook.steps.forEach((step, i) => {
        md += `${i + 1}. **${step.action.toUpperCase()}:** ${step.description}\n`;
        md += `   - Command: \`${step.command}\`\n`;
        md += `   - Verify: ${step.verify}\n\n`;
    });

    md += `## Prevention\n\n`;
    md += `${runbook.prevention}\n`;

    if (runbook.relatedAlerts.length > 0) {
        md += `\n## Related Alerts\n\n`;
        runbook.relatedAlerts.forEach(a => md += `- ${a}\n`);
    }

    return md;
}

module.exports = {
    init,
    list,
    get,
    searchBySymptom,
    getByAlert,
    getByCategory,
    getSeverityLevels,
    getQuickReference,
    exportAsMarkdown
};
