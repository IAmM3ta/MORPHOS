/** Panel stubs — Field / Image / Body / Sound / Sync (parity hooks). */

export type PanelId = 'field' | 'image' | 'body' | 'sound' | 'sync';

export const PANEL_LABELS: Record<PanelId, string> = {
  field: 'Field',
  image: 'Image',
  body: 'Body',
  sound: 'Sound',
  sync: 'Sync',
};

export type PanelHandlers = {
  onPanel?: (id: PanelId) => void;
  onLockLoop?: () => void;
  onReset?: () => void;
};

export function mountPanelStubs(root: HTMLElement, handlers: PanelHandlers): () => void {
  const note = root.querySelector<HTMLElement>('#panelNote');
  const onClick = (ev: Event) => {
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    const panel = t.getAttribute('data-panel') as PanelId | null;
    if (panel) {
      handlers.onPanel?.(panel);
      if (note) note.textContent = `panel: ${PANEL_LABELS[panel]} (stub)`;
    }
    if (t.id === 'lockLoop') handlers.onLockLoop?.();
    if (t.id === 'resetField') handlers.onReset?.();
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
