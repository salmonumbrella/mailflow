import { registerPluginMeta, registerSlot } from '../registry.js';
import CalendarView from './CalendarView.jsx';
registerPluginMeta('local-calendar', { navigation: { labelKey: 'localCalendar.title', label: 'MailFlow calendar', symbol: '▦' } });
registerSlot('auxiliary-view', { pluginId: 'local-calendar', isActive: ctx => ctx.view === 'local-calendar', render: ctx => <CalendarView key={ctx.userId} onBack={ctx.onBack} /> });
