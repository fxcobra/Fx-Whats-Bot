// serviceUtils.js
// Helper for recursive submenu/service discovery
import Service from './models/Service.js';

/**
 * Recursively builds the full category breadcrumb for a service.
 * @param {ObjectId|string|Service} serviceOrId - Service instance or its ID
 * @returns {Promise<Array>} Array of service names from root to leaf
 */
export async function getServiceBreadcrumb(serviceOrId) {
    if (typeof console !== 'undefined') {
        console.log('[Breadcrumb Debug] getServiceBreadcrumb called with:', serviceOrId);
    }
    let service = serviceOrId;
    // Always resolve to a service object
    if (typeof service === 'string' || (typeof service === 'object' && service._id === undefined)) {
        const found = await Service.findById(serviceOrId).lean();
        if (typeof console !== 'undefined') {
            console.log('[Breadcrumb Debug] Service.findById result:', found);
        }
        service = found;
        if (!service) return [];
    } else if (typeof service === 'object' && service._id && service.name === undefined) {
        // If we have an _id but no name, fetch the full object
        const found = await Service.findById(service._id).lean();
        if (typeof console !== 'undefined') {
            console.log('[Breadcrumb Debug] Service.findById (by _id) result:', found);
        }
        service = found || service;
    }
    if (!service.parentId) {
        if (typeof console !== 'undefined') {
            console.log('[Breadcrumb Debug] Reached root or no parentId, service:', service);
        }
        return [service.name || '(Unnamed Service)'];
    } else {
        const parent = await Service.findById(service.parentId).lean();
        if (typeof console !== 'undefined') {
            console.log('[Breadcrumb Debug] Looking up parentId:', service.parentId, 'Result:', parent);
        }
        if (!parent) return [service.name || '(Unnamed Service)'];
        const parentBreadcrumb = await getServiceBreadcrumb(parent);
        if (typeof console !== 'undefined') {
            console.log('[Breadcrumb Debug] parentBreadcrumb:', parentBreadcrumb);
        }
        // Filter out undefined/null in the breadcrumb
        return [...(parentBreadcrumb || []).filter(Boolean), service.name || '(Unnamed Service)'];
    }
}

/**
 * Recursively finds all leaf (orderable) services under a given parent.
 * @param {ObjectId|string} parentId - The parent service ID
 * @returns {Promise<Array>} Array of leaf services (with price > 0)
 */
export async function findAllOrderableServices(parentId) {
    const subServices = await Service.find({ parentId });
    let orderable = [];
    for (const s of subServices) {
        if (s.price && s.price > 0) {
            orderable.push(s);
        } else {
            const nested = await findAllOrderableServices(s._id);
            orderable = orderable.concat(nested);
        }
    }
    return orderable;
}

/**
 * Checks if there are any orderable services (with price) under a given parent, recursively.
 * @param {ObjectId|string} parentId
 * @returns {Promise<boolean>}
 */
export async function hasOrderableServices(parentId) {
    const subServices = await Service.find({ parentId });
    for (const s of subServices) {
        if (s.price && s.price > 0) {
            return true;
        } else if (await hasOrderableServices(s._id)) {
            return true;
        }
    }
    return false;
}
