import router from './routes.js';
export const calendarPlugin = {
  id: 'local-calendar', name: 'MailFlow calendar', version: '1.0.0', tier: 1,
  router: { base: '/api/local-calendar', handler: router },
};
