'use strict';
// Точка входа для `node --test tests/` (Node 22 разрешает каталог как модуль через index.js).
require('./api.test.js');
require('./v2.test.js');
require('./v5.test.js');
require('./requirements.test.js');
require('./ui-rewards.test.js');
require('./ui-triage.test.js');

require('./team-workflow.test.js');
require('./personal-assistant.test.js');
require('./assistant-worker.test.js');
require('./assistant-node.test.js');
require('./owner-reports.test.js');
require('./owner-report-ai.test.js');
