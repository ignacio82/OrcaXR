import { unsavedProjectLabels, type UnsavedProjectDecision } from '../UnsavedProjectDecision';
import type { XrUiAdapter } from './XrUiAdapter';
import { createXrButton, createXrSectionHeading } from './XrComponents';

export function renderXrUnsavedProjectDialog<P, I, T>(
  ui: XrUiAdapter<P, I, T>,
  root: P,
  projectName: string,
  choose: (choice: UnsavedProjectDecision) => void,
): void {
  const labels = unsavedProjectLabels(projectName);
  const panel = ui.createPanel({
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    padding: 16,
    gap: 14,
    overflow: 'scroll',
  });
  ui.appendChild(root, panel);
  ui.appendChild(panel, createXrSectionHeading(ui, labels.title));
  ui.appendChild(panel, ui.createText(labels.detail, { fontSize: 18 }));
  ui.appendChild(panel, ui.createText(labels.handoff, { fontSize: 14 }));
  for (const choice of labels.choices)
    ui.appendChild(
      panel,
      createXrButton(ui, { label: choice.label, onClick: () => choose(choice.id), paddingTop: 12, paddingBottom: 12 })
        .root,
    );
}
