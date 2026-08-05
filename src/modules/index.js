const registry = require('../core/moduleRegistry');

// Load all modules here (scheduler early so deferred intents are registered;
// matchIntent also prefers scheduler when multiple match)
require('./meta');
require('./schedulerModule');
require('./memory');
require('./web');
require('./travel');
require('./release');
require('./jira');
require('./github');
require('./browser');
require('./teams');

module.exports = registry;
