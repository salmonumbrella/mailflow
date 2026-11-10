import router from './routes.js';

export const privateNotesPlugin = {
  id: 'private-notes',
  name: 'Private thread notes',
  version: '1.0.0',
  tier: 1,
  router: { base: '/api/private-notes', handler: router },
};
