'use strict';

const { normalizeEmail } = require('./reply-all');

// Mailbox names that are not a person's first name.
const ROLE_LOCALS = new Set([
  'info', 'office', 'admin', 'administrator', 'sales', 'team', 'hello', 'hi', 'contact', 'support', 'service',
  'services', 'accounting', 'accounts', 'billing', 'ops', 'operations', 'marketing', 'mail', 'email', 'inbox',
  'leads', 'lead', 'reception', 'general', 'enquiries', 'inquiries', 'help', 'hr', 'jobs', 'careers', 'bookings',
  'booking', 'orders', 'noreply', 'owner', 'manager', 'dispatch', 'estimating', 'estimates', 'customerservice',
]);

/**
 * First name for "Hi <name>," from the contact's email local part (the client record only stores
 * addresses, no names). john.smith@ -> John, john@ -> John. Role mailboxes (info@, office@),
 * initials, digits-only and one-letter locals give '' so the greeting falls back to "Hi there,".
 */
function firstNameFromEmail(email) {
  const local = String(normalizeEmail(email) || '').split('@')[0] || '';
  const withoutTag = local.split('+')[0];
  const token = withoutTag.split(/[._-]+/).find((t) => t) || '';
  if (!/^[a-z]{2,20}$/.test(token)) return '';
  if (ROLE_LOCALS.has(token) || ROLE_LOCALS.has(withoutTag.replace(/[._-]+/g, ''))) return '';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

module.exports = { firstNameFromEmail };
