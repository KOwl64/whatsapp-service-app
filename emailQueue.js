// Email Queue Module - placeholder implementation
const fs = require('fs');
const path = require('path');

// Simple in-memory queue storage
const QUEUE_FILE = path.join(__dirname, 'email_queue.json');

function loadQueue() {
    try {
        if (fs.existsSync(QUEUE_FILE)) {
            return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading email queue:', e.message);
    }
    return { emails: [], deliveryLog: [] };
}

function saveQueue(queue) {
    try {
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
    } catch (e) {
        console.error('Error saving email queue:', e.message);
    }
}

module.exports = {
    init: () => {
        console.log('Email queue initialized (stub)');
    },

    process: () => {
        console.log('Email queue processing (stub)');
    },

    stopProcessor: () => {
        console.log('Email processor stopped');
    },

    queueEmail: (data) => {
        const queue = loadQueue();
        const id = Date.now();
        queue.emails.push({
            id,
            ...data,
            status: 'PENDING',
            created_at: new Date().toISOString()
        });
        saveQueue(queue);
        console.log(`Email queued: ${id}`);
        return id;
    },

    getQueueStats: () => {
        const queue = loadQueue();
        const pending = queue.emails.filter(e => e.status === 'PENDING').length;
        const sent = queue.emails.filter(e => e.status === 'SENT').length;
        const failed = queue.emails.filter(e => e.status === 'FAILED' || e.status === 'BOUNCED').length;
        return {
            pending,
            sent,
            failed,
            total: queue.emails.length
        };
    },

    getEmailById: (id) => {
        const queue = loadQueue();
        return queue.emails.find(e => e.id === id);
    },

    retryEmail: (id) => {
        const queue = loadQueue();
        const email = queue.emails.find(e => e.id === parseInt(id));
        if (email) {
            email.status = 'PENDING';
            email.error = null;
            saveQueue(queue);
            return true;
        }
        return false;
    },

    cancelEmail: (id) => {
        const queue = loadQueue();
        const idx = queue.emails.findIndex(e => e.id === parseInt(id));
        if (idx !== -1) {
            queue.emails.splice(idx, 1);
            saveQueue(queue);
            return true;
        }
        return false;
    },

    logDeliveryEvent: (emailId, attachmentId, event, details) => {
        const queue = loadQueue();
        queue.deliveryLog.push({
            email_id: emailId,
            attachment_id: attachmentId,
            event,
            details,
            timestamp: new Date().toISOString()
        });
        saveQueue(queue);
    },

    getDeliveryLog: (emailId) => {
        const queue = loadQueue();
        return queue.deliveryLog.filter(l => l.email_id === parseInt(emailId));
    }
};
