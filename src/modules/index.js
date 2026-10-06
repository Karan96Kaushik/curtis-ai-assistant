const registry = require('../core/moduleRegistry');

// Load all modules here (scheduler early so deferred intents are registered;
// matchIntent also prefers scheduler when multiple match). Timesheet goes first
// so "help me fill my timesheet" / "timesheet from my Jira activity" don't
// route to meta or the jira/github monthly reports.
require('./timesheet');
require('./meta');
require('./schedulerModule');
require('./memory');
require('./web');
require('./release');
require('./jira');
require('./github');
require('./browser');
require('./teams');

module.exports = registry;
