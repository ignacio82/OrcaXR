import type { ImportCommitConfirmation, ProjectImportPreview } from '../project/import/types';

interface PreviewNoticeRow {
  readonly id: string;
  readonly category: 'Repair' | 'Conflict' | 'Dropped field' | 'Diagnostic';
  readonly message: string;
  readonly detail: string;
  readonly required: boolean;
  readonly blocking: boolean;
}

export function projectImportNoticeRows(preview: ProjectImportPreview): readonly PreviewNoticeRow[] {
  const required = new Set(preview.requiredAcknowledgementIds);
  return [
    ...preview.repairs.map((notice): PreviewNoticeRow => ({
      id: notice.id,
      category: 'Repair',
      message: notice.message,
      detail: `${notice.kind} · ${notice.path}`,
      required: required.has(notice.id),
      blocking: false,
    })),
    ...preview.conflicts.map((notice): PreviewNoticeRow => ({
      id: notice.id,
      category: 'Conflict',
      message: notice.message,
      detail: [notice.kind, notice.path, notice.resolution ? `resolution: ${notice.resolution}` : 'unresolved']
        .filter(Boolean)
        .join(' · '),
      required: required.has(notice.id),
      blocking: !notice.resolution,
    })),
    ...preview.droppedFields.map((notice): PreviewNoticeRow => ({
      id: notice.id,
      category: 'Dropped field',
      message: notice.message,
      detail: `${notice.path} · ${notice.field}`,
      required: required.has(notice.id),
      blocking: false,
    })),
    ...preview.diagnostics.map((notice): PreviewNoticeRow => ({
      id: notice.id,
      category: 'Diagnostic',
      message: notice.message,
      detail: `${notice.severity} · ${notice.code} · ${notice.path}`,
      required: false,
      blocking: notice.severity === 'error',
    })),
  ];
}

/**
 * Accessible DOM counterpart for the worker import preview. Every required
 * repair/conflict/drop must be individually visible and acknowledged; the
 * caller receives only the IDs the user actually checked.
 */
export function showProjectImportPreviewDialog(
  preview: ProjectImportPreview,
): Promise<ImportCommitConfirmation | null> {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const rows = projectImportNoticeRows(preview);
  const acknowledged = new Set<string>();

  const overlay = document.createElement('div');
  overlay.dataset.projectImportPreview = 'true';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;background:#000b;display:flex;align-items:center;' +
    'justify-content:center;padding:20px;box-sizing:border-box;';

  const dialog = document.createElement('section');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'project-import-preview-title');
  dialog.setAttribute('aria-describedby', 'project-import-preview-summary');
  dialog.style.cssText =
    'width:min(760px,100%);max-height:min(820px,92vh);overflow:auto;background:#15191f;color:#eef2f5;' +
    'border:1px solid #ffffff2e;border-radius:14px;box-shadow:0 18px 60px #000a;padding:22px;' +
    'box-sizing:border-box;font:14px/1.45 system-ui,sans-serif;';
  overlay.appendChild(dialog);

  const title = document.createElement('h2');
  title.id = 'project-import-preview-title';
  title.textContent = preview.blocked ? 'Project cannot be opened' : `Open “${preview.projectName}”?`;
  title.style.cssText = 'margin:0 0 8px;font-size:22px;';
  dialog.appendChild(title);

  const summary = document.createElement('p');
  summary.id = 'project-import-preview-summary';
  summary.textContent = `${preview.counts.plates} plate(s), ${preview.counts.objects} object(s), ${preview.counts.assets} asset(s). ${
    preview.blocked
      ? 'Review every reported problem below. This preview cannot be committed.'
      : 'Confirming replaces the live project as one undoable canonical command.'
  }`;
  summary.style.cssText = 'margin:0 0 16px;color:#c7d0d8;';
  dialog.appendChild(summary);

  const noticeList = document.createElement('div');
  noticeList.setAttribute('aria-label', 'Import notices');
  noticeList.style.cssText = 'display:grid;gap:8px;';
  dialog.appendChild(noticeList);

  const requiredInputs = new Map<string, HTMLInputElement>();
  if (rows.length === 0) {
    const none = document.createElement('p');
    none.textContent = 'No repairs, conflicts, dropped fields, or diagnostics were reported.';
    none.style.cssText = 'margin:0;padding:12px;background:#ffffff0a;border-radius:8px;';
    noticeList.appendChild(none);
  } else {
    for (const row of rows) {
      const item = document.createElement(row.required ? 'label' : 'div');
      item.dataset.noticeId = row.id;
      item.style.cssText =
        `display:grid;grid-template-columns:${row.required ? '22px 1fr' : '1fr'};gap:9px;` +
        `padding:11px;border:1px solid ${row.blocking ? '#ef535066' : '#ffffff1f'};` +
        `border-radius:8px;background:${row.blocking ? '#7f1d1d40' : '#ffffff08'};`;
      if (row.required) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.acknowledgementId = row.id;
        checkbox.setAttribute('aria-label', `Acknowledge ${row.category}: ${row.message}`);
        checkbox.style.cssText = 'width:18px;height:18px;margin:2px 0 0;';
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) acknowledged.add(row.id);
          else acknowledged.delete(row.id);
          updateConfirmAvailability();
        });
        requiredInputs.set(row.id, checkbox);
        item.appendChild(checkbox);
      }
      const copy = document.createElement('div');
      const heading = document.createElement('strong');
      heading.textContent = `${row.category}: ${row.message}`;
      heading.style.cssText = 'display:block;color:#fff;';
      const detail = document.createElement('span');
      detail.textContent = row.detail;
      detail.style.cssText = 'display:block;margin-top:3px;color:#aeb8c1;font-size:12px;overflow-wrap:anywhere;';
      copy.append(heading, detail);
      item.appendChild(copy);
      noticeList.appendChild(item);
    }
  }

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:18px;';
  dialog.appendChild(actions);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = preview.blocked ? 'Close' : 'Cancel';
  cancel.style.cssText =
    'border:1px solid #ffffff38;background:#ffffff0d;color:#eef2f5;border-radius:8px;padding:9px 16px;cursor:pointer;';
  actions.appendChild(cancel);

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.textContent = 'Replace project';
  confirm.style.cssText =
    'border:0;background:#2477db;color:#fff;border-radius:8px;padding:9px 16px;font-weight:650;cursor:pointer;';
  if (!preview.blocked) actions.appendChild(confirm);

  let resolveDialog!: (value: ImportCommitConfirmation | null) => void;
  let settled = false;
  const promise = new Promise<ImportCommitConfirmation | null>((resolve) => {
    resolveDialog = resolve;
  });
  const settle = (value: ImportCommitConfirmation | null) => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    previousFocus?.focus();
    resolveDialog(value);
  };
  const requiredIds = [...preview.requiredAcknowledgementIds];
  function updateConfirmAvailability() {
    confirm.disabled = preview.blocked || requiredIds.some((id) => !acknowledged.has(id));
    confirm.setAttribute('aria-disabled', String(confirm.disabled));
    confirm.style.opacity = confirm.disabled ? '0.5' : '1';
    confirm.style.cursor = confirm.disabled ? 'not-allowed' : 'pointer';
  }
  const focusable = () =>
    [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])')].filter(
      (element) => element.offsetParent !== null,
    );
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      settle(null);
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? items[(index <= 0 ? items.length : index) - 1] : items[(index + 1) % items.length];
    event.preventDefault();
    next.focus();
  }

  cancel.addEventListener('click', () => settle(null));
  confirm.addEventListener('click', () => {
    if (confirm.disabled) return;
    settle({ confirmed: true, acknowledgedNoticeIds: requiredIds.filter((id) => acknowledged.has(id)) });
  });
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) settle(null);
  });
  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(overlay);
  updateConfirmAvailability();
  (requiredInputs.values().next().value ?? cancel).focus();
  return promise;
}
