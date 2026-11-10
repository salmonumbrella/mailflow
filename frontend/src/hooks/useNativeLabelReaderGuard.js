import { useStore } from '../store/index.js';
import { nativeLabelActionsBlocked } from '../utils/nativeLabelNavigation.js';

// Preserve the retained reader, but do not let its old locators reach a command.
// React capture also covers action menus rendered through a reader-owned portal.
export function useNativeLabelReaderGuard() {
  const blocked = useStore(nativeLabelActionsBlocked);
  const intercept = event => {
    if (!nativeLabelActionsBlocked(useStore.getState()) || event.target.closest?.('[data-native-label-safe]')) return;
    if (event.type === 'contextmenu' || event.type === 'keydown' || event.target.closest?.('button,a,input,select,textarea,[role="button"],[role="menuitem"]')) {
      event.preventDefault(); event.stopPropagation();
    }
  };
  return { blocked, props: { onClickCapture: intercept, onPointerDownCapture: intercept, onContextMenuCapture: intercept, onKeyDownCapture: event => { if (event.key === 'Enter' || event.key === ' ') intercept(event); } } };
}
