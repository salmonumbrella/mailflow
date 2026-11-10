export function isVisibleSettingsOpener(element) {
  if (!element?.isConnected || typeof element.focus !== 'function') return false;
  for (let node = element; node instanceof Element; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

export function mobileSettingsOpener(body, menuLabel) {
  const controls = [...(body?.querySelectorAll('button:not(:disabled)') || [])]
    .filter(element => !element.closest('.mailflow-sidebar, #mailflow-gmail-quick-settings') && isVisibleSettingsOpener(element));
  return controls.find(element => element.getAttribute('aria-label') === menuLabel) || controls[0] || body;
}
