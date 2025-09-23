// Lead Distribution Platform - Centralized JavaScript
// Handles all interactive functionality with delegated event listeners

document.addEventListener('DOMContentLoaded', function() {
    console.log('Lead Distribution Platform JS loaded');
    
    // Initialize all interactive components
    initializeDataTables();
    initializeEventHandlers();
    initializeToasts();
});

// Event delegation for all interactive elements
function initializeEventHandlers() {
    // Use event delegation to handle all button clicks
    document.addEventListener('click', function(e) {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        
        const action = target.getAttribute('data-action');
        const id = target.getAttribute('data-id');
        
        // Prevent default for all actions
        e.preventDefault();
        
        // Route to appropriate handler
        switch(action) {
            case 'edit-partner':
                editPartner(id);
                break;
            case 'delete-partner':
                deletePartner(id);
                break;
            case 'manage-crm':
                // Check if this is from partners page (needs partner route) or integrations page
                const idType = target.getAttribute('data-id-type') || 'partner';
                const customUrl = target.getAttribute('data-url');
                if (customUrl) {
                    window.location.href = customUrl;
                } else if (idType === 'partner') {
                    window.location.href = `/crm-integrations/partner/${id}`;
                } else {
                    window.location.href = `/crm-integrations/${id}`;
                }
                break;
            case 'view-status':
                viewStatus(id);
                break;
            case 'view-delivery-details':
                viewDeliveryDetails(id);
                break;
            case 'copy-token':
                copyToClipboard(target.getAttribute('data-value'));
                break;
            case 'copy-url':
                copyToClipboard(target.getAttribute('data-value'));
                break;
            case 'toggle-webhook-status':
                toggleWebhookStatus(id);
                break;
            case 'delete-webhook-source':
                deleteWebhookSource(id);
                break;
            case 'retry-delivery':
                retryDelivery(id);
                // Handle modal dismissal if specified
                if (target.getAttribute('data-dismiss-modal')) {
                    const modal = bootstrap.Modal.getInstance(document.getElementById('deliveryDetailsModal')) || 
                                  new bootstrap.Modal(document.getElementById('deliveryDetailsModal'));
                    if (modal) modal.hide();
                }
                break;
            default:
                console.warn('Unknown action:', action);
        }
    });
}

// Initialize DataTables with consistent settings
function initializeDataTables() {
    if (typeof $.fn.DataTable !== 'undefined') {
        $('.data-table').DataTable({
            pageLength: 25,
            responsive: true,
            language: {
                search: "Search:",
                lengthMenu: "Show _MENU_ entries",
                info: "Showing _START_ to _END_ of _TOTAL_ entries",
                infoEmpty: "No entries available",
                infoFiltered: "(filtered from _MAX_ total entries)"
            },
            dom: '<"row"<"col-sm-12 col-md-6"l><"col-sm-12 col-md-6"f>>' +
                 '<"row"<"col-sm-12"tr>>' +
                 '<"row"<"col-sm-12 col-md-5"i><"col-sm-12 col-md-7"p>>',
        });
    }
}

// Toast notifications
function initializeToasts() {
    window.showToast = function(message, type = 'info') {
        // Create toast element
        const toastHtml = `
            <div class="toast align-items-center text-white bg-${type === 'error' ? 'danger' : type === 'success' ? 'success' : 'primary'} border-0" role="alert">
                <div class="d-flex">
                    <div class="toast-body">${message}</div>
                    <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
                </div>
            </div>
        `;
        
        // Add to page if toast container exists
        let container = document.querySelector('#toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container position-fixed top-0 end-0 p-3';
            container.style.zIndex = '9999';
            document.body.appendChild(container);
        }
        
        container.insertAdjacentHTML('beforeend', toastHtml);
        const toastElement = container.lastElementChild;
        const toast = new bootstrap.Toast(toastElement);
        toast.show();
        
        // Remove after hiding
        toastElement.addEventListener('hidden.bs.toast', () => {
            toastElement.remove();
        });
    };
}

// Copy to clipboard functionality
function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Copied to clipboard!', 'success');
        }).catch(() => {
            fallbackCopyToClipboard(text);
        });
    } else {
        fallbackCopyToClipboard(text);
    }
}

function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        showToast('Copied to clipboard!', 'success');
    } catch (err) {
        showToast('Failed to copy to clipboard', 'error');
    }
    document.body.removeChild(textArea);
}

// Partner management functions
function editPartner(id) {
    // Find partner data from window.partners if available
    if (typeof window.partners !== 'undefined') {
        const partner = window.partners.find(p => p.id == id);
        if (!partner) {
            showToast('Partner not found', 'error');
            return;
        }
        
        // Fill edit form with current data
        document.getElementById('editPartnerId').value = partner.id;
        document.getElementById('editPartnerName').value = partner.name;
        document.getElementById('editPartnerEmail').value = partner.email;
        document.getElementById('editPartnerCountry').value = partner.country;
        document.getElementById('editPartnerNiche').value = partner.niche;
        document.getElementById('editPartnerDailyLimit').value = partner.daily_limit;
        document.getElementById('editPartnerPremiumRatio').value = (partner.premium_ratio * 100).toFixed(2);
        document.getElementById('editPartnerStatus').value = partner.status;
        document.getElementById('editPartnerTimezone').value = partner.timezone;
        document.getElementById('editPartnerRecoveryFormat').value = partner.recovery_fields_format || 'separate';
        
        // Show modal
        new bootstrap.Modal(document.getElementById('editPartnerModal')).show();
    } else {
        showToast('Partner data not available', 'error');
    }
}

function deletePartner(id) {
    if (confirm('Are you sure you want to delete this partner?')) {
        fetch(`/partners/${id}`, {
            method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Partner deleted successfully', 'success');
                setTimeout(() => location.reload(), 1000);
            } else {
                showToast('Failed to delete partner', 'error');
            }
        })
        .catch(error => {
            console.error('Delete error:', error);
            showToast('Network error deleting partner', 'error');
        });
    }
}

// Status tracking function
function viewStatus(partnerId) {
    if (typeof window.partners === 'undefined') {
        showToast('Partner data not available', 'error');
        return;
    }
    
    const partner = window.partners.find(p => p.id == partnerId);
    if (!partner) {
        showToast('Partner not found', 'error');
        return;
    }
    
    // Update modal title with partner name
    document.querySelector('#statusTrackingModal .modal-title').textContent = 
        `Lead Status Tracking - ${partner.name}`;
    
    // Show loading spinner
    document.getElementById('statusTrackingContent').innerHTML = `
        <div class="d-flex justify-content-center">
            <div class="spinner-border" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;
    
    // Load status data
    fetch(`/partners/${partnerId}/status-tracking`)
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                renderStatusTracking(data);
            } else {
                document.getElementById('statusTrackingContent').innerHTML = 
                    '<div class="alert alert-danger">Failed to load status tracking data</div>';
            }
        })
        .catch(error => {
            console.error('Status tracking error:', error);
            document.getElementById('statusTrackingContent').innerHTML = 
                '<div class="alert alert-danger">Network error loading status data</div>';
        });
    
    // Show modal
    new bootstrap.Modal(document.getElementById('statusTrackingModal')).show();
}

// Webhook delivery details function
function viewDeliveryDetails(id) {
    fetch(`/webhooks/deliveries/${id}`)
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                displayDeliveryDetails(data.delivery);
            } else {
                showToast('Failed to load delivery details', 'error');
            }
        })
        .catch(error => {
            console.error('Error loading delivery details:', error);
            showToast('Network error loading delivery details', 'error');
        });
}

function displayDeliveryDetails(delivery) {
    const modalHtml = `
        <div class="modal fade" id="deliveryDetailsModal" tabindex="-1">
            <div class="modal-dialog modal-xl">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Delivery Details - ID: ${delivery.id}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <!-- Lead Information -->
                        <div class="row mb-4">
                            <div class="col-md-6">
                                <h6 class="fw-bold text-primary">Lead Information</h6>
                                <table class="table table-sm">
                                    <tr><td class="fw-bold">Name:</td><td>${delivery.first_name} ${delivery.last_name}</td></tr>
                                    <tr><td class="fw-bold">Email:</td><td>${delivery.email}</td></tr>
                                    <tr><td class="fw-bold">Phone:</td><td>${delivery.phone || 'N/A'}</td></tr>
                                    <tr><td class="fw-bold">Country:</td><td>${delivery.lead_country}</td></tr>
                                    <tr><td class="fw-bold">Niche:</td><td><span class="badge bg-${delivery.lead_niche === 'forex' ? 'success' : 'warning'}">${delivery.lead_niche}</span></td></tr>
                                    <tr><td class="fw-bold">Type:</td><td><span class="badge bg-${delivery.type === 'premium' ? 'primary' : 'secondary'}">${delivery.type}</span></td></tr>
                                </table>
                            </div>
                            <div class="col-md-6">
                                <h6 class="fw-bold text-success">Partner Information</h6>
                                <table class="table table-sm">
                                    <tr><td class="fw-bold">Partner:</td><td>${delivery.partner_name}</td></tr>
                                    <tr><td class="fw-bold">Country:</td><td>${delivery.partner_country}</td></tr>
                                    <tr><td class="fw-bold">Niche:</td><td><span class="badge bg-${delivery.partner_niche === 'forex' ? 'success' : 'warning'}">${delivery.partner_niche}</span></td></tr>
                                    <tr><td class="fw-bold">Webhook URL:</td><td><code style="font-size: 0.8rem; word-break: break-all;">${delivery.webhook_url}</code></td></tr>
                                </table>
                            </div>
                        </div>

                        <!-- Delivery Status -->
                        <div class="row mb-4">
                            <div class="col-12">
                                <h6 class="fw-bold text-warning">Delivery Status</h6>
                                <table class="table table-sm">
                                    <tr>
                                        <td class="fw-bold">Status:</td>
                                        <td>
                                            <span class="badge bg-${delivery.status === 'success' ? 'success' : (delivery.status === 'failed' ? 'danger' : 'warning')} fs-6">
                                                ${delivery.status.toUpperCase()}
                                            </span>
                                        </td>
                                    </tr>
                                    <tr><td class="fw-bold">Attempts:</td><td>${delivery.attempts}</td></tr>
                                    <tr><td class="fw-bold">Created:</td><td>${new Date(delivery.created_at).toLocaleString()}</td></tr>
                                    ${delivery.delivered_at ? `<tr><td class="fw-bold">Delivered:</td><td>${new Date(delivery.delivered_at).toLocaleString()}</td></tr>` : ''}
                                    ${delivery.response_code ? `<tr><td class="fw-bold">Response Code:</td><td><span class="badge bg-${delivery.response_code >= 200 && delivery.response_code < 300 ? 'success' : 'danger'}">HTTP ${delivery.response_code}</span></td></tr>` : ''}
                                </table>
                            </div>
                        </div>

                        <!-- Payload Sent -->
                        <div class="mb-4">
                            <h6 class="fw-bold text-info">Payload Sent to Partner</h6>
                            <div class="bg-light border rounded p-3">
                                <pre style="margin: 0; font-size: 0.85rem; white-space: pre-wrap;">${delivery.payload ? JSON.stringify(delivery.payload, null, 2) : 'No payload data'}</pre>
                            </div>
                        </div>

                        <!-- Partner Response -->
                        ${delivery.response_body ? `
                        <div class="mb-4">
                            <h6 class="fw-bold text-${delivery.status === 'success' ? 'success' : 'danger'}">Partner Response</h6>
                            <div class="bg-light border rounded p-3">
                                <pre style="margin: 0; font-size: 0.85rem; white-space: pre-wrap; color: ${delivery.status === 'success' ? '#198754' : '#dc3545'};">${typeof delivery.response_body === 'object' ? JSON.stringify(delivery.response_body, null, 2) : delivery.response_body}</pre>
                            </div>
                        </div>` : ''}
                    </div>
                    <div class="modal-footer">
                        ${delivery.status === 'failed' && delivery.attempts < 3 ? `
                        <button type="button" class="btn btn-success" onclick="retryDelivery(${delivery.id}); $('#deliveryDetailsModal').modal('hide');">
                            <i class="fas fa-redo me-2"></i>Retry Delivery
                        </button>` : ''}
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if present
    const existing = document.getElementById('deliveryDetailsModal');
    if (existing) existing.remove();

    // Add modal to page and show
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = new bootstrap.Modal(document.getElementById('deliveryDetailsModal'));
    modal.show();
    
    // Clean up when modal is hidden
    document.getElementById('deliveryDetailsModal').addEventListener('hidden.bs.modal', function() {
        this.remove();
    });
}

// Webhook management functions
function toggleWebhookStatus(id) {
    fetch(`/webhooks/sources/${id}/toggle`, {
        method: 'POST'
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showToast(`Webhook ${data.status}`, 'success');
            setTimeout(() => location.reload(), 1000);
        } else {
            showToast('Failed to toggle webhook status', 'error');
        }
    })
    .catch(error => {
        console.error('Toggle error:', error);
        showToast('Network error toggling webhook status', 'error');
    });
}

function deleteWebhookSource(id) {
    if (confirm('Are you sure you want to delete this webhook source?')) {
        fetch(`/webhooks/sources/${id}`, {
            method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Webhook source deleted successfully', 'success');
                setTimeout(() => location.reload(), 1000);
            } else {
                showToast('Failed to delete webhook source', 'error');
            }
        })
        .catch(error => {
            console.error('Delete error:', error);
            showToast('Network error deleting webhook source', 'error');
        });
    }
}

// Status tracking rendering function
function renderStatusTracking(data) {
    const { summary, recent_updates, postback_config } = data;
    
    const html = `
        <!-- Summary Cards -->
        <div class="row mb-4">
            <div class="col-md-3">
                <div class="card bg-primary text-white">
                    <div class="card-body">
                        <h6 class="card-title">Total Leads</h6>
                        <h3>${summary.total_leads}</h3>
                    </div>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card bg-success text-white">
                    <div class="card-body">
                        <h6 class="card-title">Conversions</h6>
                        <h3>${summary.conversions}</h3>
                        <small>${summary.conversion_rate}% rate</small>
                    </div>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card bg-warning text-white">
                    <div class="card-body">
                        <h6 class="card-title">Revenue</h6>
                        <h3>$${(summary.total_revenue || 0).toFixed(2)}</h3>
                    </div>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card bg-info text-white">
                    <div class="card-body">
                        <h6 class="card-title">Avg Quality</h6>
                        <h3>${(summary.avg_quality || 0).toFixed(1)}/10</h3>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Configuration Section -->
        <div class="card mb-4">
            <div class="card-header">
                <h6><i class="fas fa-cogs me-2"></i>Tracking Configuration</h6>
            </div>
            <div class="card-body">
                <div class="row">
                    <div class="col-md-6">
                        <strong>Postback URL:</strong><br>
                        <code>/api/postback/status/${postback_config?.postback_token || 'Not configured'}</code>
                        ${postback_config?.postback_token ? 
                            '<span class="badge bg-success ms-2">Active</span>' : 
                            '<span class="badge bg-warning ms-2">Not Setup</span>'
                        }
                    </div>
                    <div class="col-md-6">
                        <strong>Status Updates:</strong><br>
                        <span class="badge bg-primary">${recent_updates.length} recent</span>
                        <span class="badge bg-secondary">Both postback & pulling enabled</span>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Recent Updates -->
        <div class="card">
            <div class="card-header">
                <h6><i class="fas fa-history me-2"></i>Recent Status Updates</h6>
            </div>
            <div class="card-body">
                ${recent_updates.length === 0 ? 
                    '<div class="alert alert-info">No recent status updates</div>' : 
                    `<div class="table-responsive">
                        <table class="table table-sm">
                            <thead>
                                <tr>
                                    <th>Lead</th>
                                    <th>Status</th>
                                    <th>Value</th>
                                    <th>Quality</th>
                                    <th>Source</th>
                                    <th>Date</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${recent_updates.map(update => `
                                    <tr>
                                        <td>
                                            <small>ID: ${update.lead_id}</small><br>
                                            <small class="text-muted">${update.lead_email}</small>
                                        </td>
                                        <td>
                                            <span class="badge bg-${getStatusColor(update.status)}">${update.status}</span>
                                        </td>
                                        <td>
                                            ${update.conversion_value ? '$' + parseFloat(update.conversion_value).toFixed(2) : '-'}
                                        </td>
                                        <td>
                                            ${update.quality_score ? update.quality_score + '/10' : '-'}
                                        </td>
                                        <td>
                                            <span class="badge bg-${update.update_source === 'postback' ? 'primary' : 'secondary'}">
                                                ${update.update_source}
                                            </span>
                                        </td>
                                        <td>
                                            <small>${new Date(update.created_at).toLocaleDateString()}</small>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>`
                }
            </div>
        </div>
    `;
    
    document.getElementById('statusTrackingContent').innerHTML = html;
}

function getStatusColor(status) {
    switch (status) {
        case 'converted': return 'success';
        case 'qualified': return 'primary';
        case 'rejected': return 'danger';
        case 'pending': return 'warning';
        default: return 'secondary';
    }
}

// Retry delivery function
function retryDelivery(id) {
    fetch(`/webhooks/deliveries/${id}/retry`, {
        method: 'POST'
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showToast('Delivery retry initiated', 'success');
            setTimeout(() => location.reload(), 1000);
        } else {
            showToast('Failed to retry delivery', 'error');
        }
    })
    .catch(error => {
        console.error('Retry error:', error);
        showToast('Network error retrying delivery', 'error');
    });
}