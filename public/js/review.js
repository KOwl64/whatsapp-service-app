// Review Queue JavaScript

// State
let currentStatus = 'REVIEW';
let currentPage = 1;
let limit = 20;
let selectedIds = new Set();
let queueData = { attachments: [], hasMore: false, total: 0 };
let currentDetailId = null;

// API Base URL
const API_BASE = '';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    loadQueue();
    // Auto-refresh every 30 seconds
    setInterval(() => {
        if (!currentDetailId) {
            loadQueue();
        }
    }, 30000);
});

// Load queue statistics
async function loadStats() {
    try {
        const res = await fetch(`${API_BASE}/api/queue/stats`);
        const stats = await res.json();

        document.getElementById('stat-review').textContent = stats.REVIEW;
        document.getElementById('stat-out').textContent = stats.OUT;
        document.getElementById('stat-quarantine').textContent = stats.QUARANTINE;

        document.getElementById('tab-review-count').textContent = stats.REVIEW;
        document.getElementById('tab-out-count').textContent = stats.OUT;
        document.getElementById('tab-quarantine-count').textContent = stats.QUARANTINE;
        document.getElementById('tab-failed-count').textContent = stats.FAILED;

        // Load export stats
        const exportsRes = await fetch(`${API_BASE}/api/exports?status=PENDING&limit=1`);
        const exportsData = await exportsRes.json();
        const exportedCount = Array.isArray(exportsData) ? exportsData.length : 0;
        document.getElementById('stat-exported').textContent = exportedCount;
        document.getElementById('tab-exported-count').textContent = exportedCount;
    } catch (error) {
        console.error('Failed to load stats:', error);
        showToast('Failed to load stats', 'error');
    }
}

// Load queue data
async function loadQueue() {
    const grid = document.getElementById('attachments-grid');
    grid.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const offset = (currentPage - 1) * limit;

        if (currentStatus === 'EXPORTED') {
            // Load exports instead of attachments
            const res = await fetch(`${API_BASE}/api/exports?limit=${limit}&offset=${offset}`);
            const exports = await res.json();
            queueData = {
                attachments: exports.map(e => ({
                    id: e.attachment_id,
                    status: 'EXPORTED',
                    created_at: e.created_at,
                    sender_id: e.recipients?.join(', ') || 'N/A',
                    job_ref: e.subject || '-',
                    vehicle_reg: '-',
                    export_id: e.id,
                    export_status: e.status,
                    export_created: e.created_at
                })),
                hasMore: exports.length >= limit,
                total: exports.length
            };
        } else {
            const res = await fetch(`${API_BASE}/api/queue/review?status=${currentStatus}&limit=${limit}&offset=${offset}`);
            queueData = await res.json();
        }

        renderGrid();
        updatePagination();
    } catch (error) {
        console.error('Failed to load queue:', error);
        grid.innerHTML = '<div class="empty">Failed to load queue</div>';
        showToast('Failed to load queue', 'error');
    }
}

// Render attachment grid
function renderGrid() {
    const grid = document.getElementById('attachments-grid');

    if (currentStatus === 'EXPORTED') {
        // Render exports grid
        if (queueData.attachments.length === 0) {
            grid.innerHTML = '<div class="empty">No exports found</div>';
            return;
        }
        grid.innerHTML = queueData.attachments.map(att => `
            <div class="card ${selectedIds.has(att.id) ? 'selected' : ''}"
                 data-id="${att.id}"
                 onclick="handleCardClick(event, '${att.id}')">
                <div class="card-body">
                    <div class="card-meta">
                        <span class="card-sender">${escapeHtml(att.sender_id || 'Unknown')}</span>
                        <span class="card-date">${formatDate(att.created_at)}</span>
                    </div>
                    <span class="card-status EXPORTED">EXPORTED</span>
                    <div class="card-fields">
                        <div class="card-field">
                            <label>Subject</label>
                            <span>${escapeHtml(att.job_ref || '-')}</span>
                        </div>
                        <div class="card-field">
                            <label>Status</label>
                            <span class="status-badge ${att.export_status}">${att.export_status || 'PENDING'}</span>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
        return;
    }

    if (queueData.attachments.length === 0) {
        grid.innerHTML = `<div class="empty">No attachments in ${currentStatus} queue</div>`;
        return;
    }

    grid.innerHTML = queueData.attachments.map(att => `
        <div class="card ${selectedIds.has(att.id) ? 'selected' : ''}"
             data-id="${att.id}"
             onclick="handleCardClick(event, '${att.id}')">
            ${selectedIds.size > 0 ? `
                <div class="card-checkbox" onclick="event.stopPropagation(); toggleSelect('${att.id}')"></div>
            ` : ''}
            <img class="card-image"
                 src="${API_BASE}/api/files/${att.id}"
                 alt="POD"
                 onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22><text x=%2250%%22 y=%2250%%22 text-anchor=%22middle%22 fill=%22%23999%22>No Image</text></svg>'">
            <div class="card-body">
                <div class="card-meta">
                    <span class="card-sender">${escapeHtml(att.sender_id || 'Unknown')}</span>
                    <span class="card-date">${formatDate(att.created_at)}</span>
                </div>
                <span class="card-status ${att.status}">${att.status}</span>
                <div class="card-fields">
                    <div class="card-field">
                        <label>Job Ref</label>
                        <span>${escapeHtml(att.job_ref || '-')}</span>
                    </div>
                    <div class="card-field">
                        <label>Vehicle</label>
                        <span>${escapeHtml(att.vehicle_reg || '-')}</span>
                    </div>
                </div>
                <div class="card-actions">
                    ${att.status === 'OUT' ? `
                        <button class="btn btn-export" onclick="event.stopPropagation(); openExportModal('${att.id}')">Export</button>
                    ` : ''}
                    <button class="btn btn-approve" onclick="event.stopPropagation(); approveOne('${att.id}')">Approve</button>
                    <button class="btn btn-reject" onclick="event.stopPropagation(); rejectOne('${att.id}')">Reject</button>
                </div>
            </div>
        </div>
    `).join('');
}

// Handle card click
function handleCardClick(event, id) {
    if (selectedIds.size > 0) {
        toggleSelect(id);
    } else {
        openDetail(id);
    }
}

// Toggle selection
function toggleSelect(id) {
    if (selectedIds.has(id)) {
        selectedIds.delete(id);
    } else {
        selectedIds.add(id);
    }
    updateBulkActions();
    renderGrid();
}

// Update bulk actions visibility
function updateBulkActions() {
    const bulkActions = document.getElementById('bulk-actions');
    const selectedCount = document.getElementById('selected-count');

    if (selectedIds.size > 0) {
        bulkActions.style.display = 'flex';
        selectedCount.textContent = selectedIds.size;
    } else {
        bulkActions.style.display = 'none';
    }
}

// Clear selection
function clearSelection() {
    selectedIds.clear();
    updateBulkActions();
    renderGrid();
}

// Switch tab
function switchTab(status) {
    currentStatus = status;
    currentPage = 1;
    selectedIds.clear();
    updateBulkActions();

    // Update tab styles
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.status === status);
    });

    loadStats();
    loadQueue();
}

// Refresh queue
function refreshQueue() {
    loadStats();
    loadQueue();
    showToast('Queue refreshed', 'success');
}

// Pagination
function updatePagination() {
    const totalPages = Math.ceil(queueData.total / limit) || 1;

    document.getElementById('current-page').textContent = currentPage;
    document.getElementById('total-pages').textContent = totalPages;

    document.getElementById('btn-prev').disabled = currentPage <= 1;
    document.getElementById('btn-next').disabled = !queueData.hasMore;
}

function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        loadQueue();
    }
}

function nextPage() {
    if (queueData.hasMore) {
        currentPage++;
        loadQueue();
    }
}

// Single actions
async function approveOne(id) {
    try {
        const res = await fetch(`${API_BASE}/api/attachments/${id}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        if (!res.ok) throw new Error('Failed to approve');

        showToast('Approved successfully', 'success');
        loadStats();
        loadQueue();
    } catch (error) {
        showToast('Failed to approve', 'error');
    }
}

async function rejectOne(id) {
    try {
        const res = await fetch(`${API_BASE}/api/attachments/${id}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'Rejected by operator' })
        });

        if (!res.ok) throw new Error('Failed to reject');

        showToast('Rejected', 'warning');
        loadStats();
        loadQueue();
    } catch (error) {
        showToast('Failed to reject', 'error');
    }
}

// Bulk actions
async function bulkApprove() {
    const ids = Array.from(selectedIds);
    await processBulkAction('approve', ids);
}

async function bulkReject() {
    const ids = Array.from(selectedIds);
    await processBulkAction('reject', ids);
}

async function processBulkAction(action, ids) {
    try {
        const res = await fetch(`${API_BASE}/api/queue/bulk-action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ids })
        });

        const result = await res.json();

        if (result.failed > 0) {
            showToast(`${result.failed} failed`, 'error');
        } else {
            showToast(`${result.success} ${action}d`, 'success');
        }

        selectedIds.clear();
        updateBulkActions();
        loadStats();
        loadQueue();
    } catch (error) {
        showToast(`Failed to ${action}`, 'error');
    }
}

// Modal functions
async function openDetail(id) {
    currentDetailId = id;
    const modal = document.getElementById('detail-modal');

    try {
        const att = await fetch(`${API_BASE}/api/attachments/${id}`).then(r => r.json());

        document.getElementById('detail-img').src = `${API_BASE}/api/files/${id}`;
        document.getElementById('detail-id').textContent = id;
        document.getElementById('detail-received').textContent = formatDate(att.created_at);
        document.getElementById('detail-sender').textContent = att.sender_id || 'Unknown';
        document.getElementById('detail-file').textContent = att.canonical_filename || 'Unknown';
        document.getElementById('detail-status').textContent = att.status;
        document.getElementById('detail-status').className = `status-badge ${att.status}`;
        document.getElementById('detail-jobref').value = att.job_ref || '';
        document.getElementById('detail-vehreg').value = att.vehicle_reg || '';

        modal.classList.add('active');
    } catch (error) {
        showToast('Failed to load details', 'error');
        currentDetailId = null;
    }
}

function closeModal() {
    document.getElementById('detail-modal').classList.remove('active');
    currentDetailId = null;
}

async function saveFromModal() {
    if (!currentDetailId) return;

    const jobRef = document.getElementById('detail-jobref').value;
    const vehicleReg = document.getElementById('detail-vehreg').value;

    try {
        const res = await fetch(`${API_BASE}/api/attachments/${currentDetailId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobRef, vehicleReg })
        });

        if (!res.ok) throw new Error('Failed to save');

        showToast('Saved', 'success');
        loadQueue();
    } catch (error) {
        showToast('Failed to save', 'error');
    }
}

async function approveFromModal() {
    if (!currentDetailId) return;

    const jobRef = document.getElementById('detail-jobref').value;
    const vehicleReg = document.getElementById('detail-vehreg').value;

    try {
        const res = await fetch(`${API_BASE}/api/attachments/${currentDetailId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobRef, vehicleReg })
        });

        if (!res.ok) throw new Error('Failed to approve');

        showToast('Approved', 'success');
        closeModal();
        loadStats();
        loadQueue();
    } catch (error) {
        showToast('Failed to approve', 'error');
    }
}

async function rejectFromModal() {
    if (!currentDetailId) return;

    const notes = document.getElementById('detail-notes').value;

    try {
        const res = await fetch(`${API_BASE}/api/attachments/${currentDetailId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'Rejected', notes })
        });

        if (!res.ok) throw new Error('Failed to reject');

        showToast('Rejected', 'warning');
        closeModal();
        loadStats();
        loadQueue();
    } catch (error) {
        showToast('Failed to reject', 'error');
    }
}

// Close modal on backdrop click
document.getElementById('detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal') {
        closeModal();
    }
});

// ============================================
// Export Functions
// ============================================

// Open export modal for an attachment
async function openExportModal(attachmentId) {
    currentDetailId = attachmentId;
    const modal = document.getElementById('detail-modal');

    try {
        const att = await fetch(`${API_BASE}/api/attachments/${attachmentId}`).then(r => r.json());

        document.getElementById('detail-img').src = `${API_BASE}/api/files/${attachmentId}`;
        document.getElementById('detail-id').textContent = attachmentId;
        document.getElementById('detail-received').textContent = formatDate(att.created_at);
        document.getElementById('detail-sender').textContent = att.sender_id || 'Unknown';
        document.getElementById('detail-file').textContent = att.canonical_filename || 'Unknown';
        document.getElementById('detail-status').textContent = att.status;
        document.getElementById('detail-status').className = `status-badge ${att.status}`;
        document.getElementById('detail-jobref').value = att.job_ref || '';
        document.getElementById('detail-vehreg').value = att.vehicle_reg || '';

        // Show export section for OUT items
        const exportSection = document.getElementById('export-section');
        const exportsList = document.getElementById('exports-list');

        if (att.status === 'OUT') {
            exportSection.style.display = 'block';
            // Pre-fill subject
            document.getElementById('export-subject').value = `POD for ${att.job_ref || att.vehicle_reg || 'Delivery'}`;
            // Load existing exports
            const exportsRes = await fetch(`${API_BASE}/api/attachments/${attachmentId}/exports`);
            const exports = await exportsRes.json();

            if (exports.length > 0) {
                exportsList.style.display = 'block';
                document.getElementById('exports-container').innerHTML = exports.map(e => `
                    <div class="export-item">
                        <span class="export-subject">${escapeHtml(e.subject || 'No subject')}</span>
                        <span class="export-recipients">${(e.recipients || []).join(', ')}</span>
                        <span class="export-date">${formatDate(e.created_at)}</span>
                        <span class="status-badge ${e.status}">${e.status}</span>
                    </div>
                `).join('');
            } else {
                exportsList.style.display = 'none';
            }
        } else {
            exportSection.style.display = 'none';
            exportsList.style.display = 'none';
        }

        modal.classList.add('active');
    } catch (error) {
        showToast('Failed to load details', 'error');
        currentDetailId = null;
    }
}

// Create export from modal
async function exportFromModal() {
    if (!currentDetailId) return;

    const recipients = document.getElementById('export-recipients').value;
    const subject = document.getElementById('export-subject').value;
    const body = document.getElementById('export-body').value;

    if (!recipients.trim()) {
        showToast('Please enter at least one recipient', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/attachments/${currentDetailId}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipients: recipients,
                subject: subject || undefined,
                body: body || undefined
            })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to create export');
        }

        showToast('Export created successfully', 'success');
        closeModal();
        loadStats();
        loadQueue();
    } catch (error) {
        showToast('Failed to create export: ' + error.message, 'error');
    }
}

// Utility functions
function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
    }
    if (e.key === 'a' && !e.ctrlKey && !e.metaKey && !currentDetailId) {
        if (queueData.attachments.length > 0) {
            selectedIds.clear();
            queueData.attachments.forEach(a => selectedIds.add(a.id));
            updateBulkActions();
            renderGrid();
        }
    }
    if (e.key === 'Escape && selectedIds.size > 0') {
        clearSelection();
    }
});
