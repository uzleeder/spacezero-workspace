'use strict';

// Per-request facts that code far from the route needs to know, without passing `req` through every call:
// who is REALLY behind the request when an Admin is "viewing as" an employee, and whether the request must leave no
// records in that employee's name. Set by lib/impersonation.js for the length of a request.
const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();

/** Runs `next` with the given context (`{ impersonatorId, readOnly }`) visible to everything it calls. */
const run = (context, next) => store.run(context, next);
const current = () => store.getStore() || null;

/** The Admin behind a "view as" request (null for an ordinary request). */
const impersonatorId = () => (current() && current().impersonatorId) || null;

/** True while an Admin views a real employee's account: nothing may be recorded in that employee's name. */
const readOnly = () => Boolean(current() && current().readOnly);

module.exports = { run, current, impersonatorId, readOnly };
