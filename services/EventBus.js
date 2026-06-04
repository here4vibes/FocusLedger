'use strict';
/**
 * services/EventBus.js — Simple in-process event emitter for cross-service communication.
 *
 * Services emit events; other services (or routes) subscribe to handle side-effects.
 * In-process only — no persistence, no cross-process delivery.
 */

const { EventEmitter } = require('events');

// Singleton event bus shared across all services
const eventBus = new EventEmitter();

// Increase max listeners to avoid warnings with many subscribers
eventBus.setMaxListeners(20);

module.exports = { eventBus };