import { registerSlot } from '../registry.js';
import PrivateThreadNotes from './PrivateThreadNotes.jsx';

registerSlot('message-reader-footer', {
  pluginId: 'private-notes',
  isActive: ctx => Boolean(ctx.message?.id && !ctx.message.is_draft),
  render: ctx => <PrivateThreadNotes message={ctx.message} />,
});
