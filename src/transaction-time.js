'use strict';

// Db2 timestamps are zone-less wall times from the Asia/Shanghai host (UTC+08:00).
function transactionTimeUtc(value) {
  const text = String(value).trim();
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(text);
  const timestamp = local ? `${local[1]}T${local[2]}${local[3] || ''}+08:00` : text;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return `${text} (unrecognized timestamp)`;
  return date.toISOString();
}

module.exports = { transactionTimeUtc };
