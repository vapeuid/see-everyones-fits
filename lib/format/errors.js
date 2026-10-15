'use strict';
// One error type for everything in lib/format, so callers can tell "this mod/file is not readable" from a bug.
// `code` is short and stable (for grouping); `message` is a sentence a person can read.
class FormatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FormatError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new FormatError(code, message); };
// Turns any thrown value into { ok:false, code, reason } for the public API (which never throws).
function softFail(e) {
  if (e instanceof FormatError) return { ok: false, code: e.code, reason: e.message };
  return { ok: false, code: 'internal', reason: 'unexpected error: ' + (e && e.message ? e.message : String(e)) };
}
module.exports = { FormatError, fail, softFail };
