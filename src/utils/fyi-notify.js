/**
 * Client FYI notify extras — ops CC and Reply-To.
 *
 * FYI_CC_EMAILS is the allowlist. When unset, the default ops teammate
 * address is used so every FYI is seen. Set the env empty to disable.
 * Replies go to FYI_REPLY_TO, else PRIMARY_GMAIL_FROM.
 */

const { parseEmailList } = require('../services/client-cc');

const FYI_NOTES_LINE =
  'If you have any notes on this reply, just hit reply all. Our operations team sees it.';

/** Default CC when FYI_CC_EMAILS is unset. Override or blank the env to change. */
const DEFAULT_FYI_CC_EMAILS = 'cayden@salesglidergrowth.com';
const DEFAULT_FYI_REPLY_TO = 'joshua@salesglidergrowth.com';

function fyiCcEmails(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, 'FYI_CC_EMAILS')) {
    return parseEmailList(env.FYI_CC_EMAILS);
  }
  return parseEmailList(DEFAULT_FYI_CC_EMAILS);
}

function fyiReplyTo(env = process.env) {
  const raw = String(env.FYI_REPLY_TO || env.PRIMARY_GMAIL_FROM || DEFAULT_FYI_REPLY_TO).trim();
  return raw.includes('@') ? raw.toLowerCase() : DEFAULT_FYI_REPLY_TO;
}

function mergeEmailLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    const parts = Array.isArray(list) ? list : parseEmailList(list);
    for (const email of parts) {
      if (seen.has(email)) continue;
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

module.exports = {
  FYI_NOTES_LINE,
  DEFAULT_FYI_CC_EMAILS,
  DEFAULT_FYI_REPLY_TO,
  fyiCcEmails,
  fyiReplyTo,
  mergeEmailLists,
};
