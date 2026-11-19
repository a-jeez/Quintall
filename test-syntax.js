const assert = require('assert');
const crypto = require('crypto');

function formatUptime(seconds) {
    const totalMins = Math.floor(seconds / 60);
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return hours > 0 ? `${hours}j ${mins}m` : `${mins}m`;
}

assert.strictEqual(formatUptime(300), '5m');
assert.strictEqual(formatUptime(3600), '1j 0m');

// Check secure token generation & session TTL
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
let adminSessions = {};
function isValidSession(token) {
    if (!token || !adminSessions[token]) return false;
    if (Date.now() - adminSessions[token] > SESSION_TTL_MS) {
        delete adminSessions[token];
        return false;
    }
    return true;
}

const token = crypto.randomBytes(32).toString('hex');
assert.strictEqual(token.length, 64);
adminSessions[token] = Date.now();
assert.strictEqual(isValidSession(token), true);
adminSessions[token] = Date.now() - SESSION_TTL_MS - 1;
assert.strictEqual(isValidSession(token), false);

console.log('ALL TESTS PASSED');

