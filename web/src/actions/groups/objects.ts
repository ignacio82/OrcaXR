import type { ActionDefinition as Action } from '../ActionRegistry';

/** Contextual Objects-tree intents shared by DOM, future XR, and automation adapters. */
export const objectsActions: Action[] = [
  {
    id: 'objects_select',
    label: 'Select Objects row',
    icon: 'scene',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Synchronize a typed Objects-tree selection with the canonical scene',
    run: (ctx, invocation) => {
      const request = invocation.objectsSelection;
      if (!request) {
        ctx.reportCapabilityUnavailable('Select Objects row', 'Choose a row in the Objects panel.');
        return;
      }
      ctx.selectObjectsTreeEntities(request.refs, request.primary);
    },
  },
  {
    id: 'objects_rename',
    label: 'Rename object or part',
    icon: 'edit',
    group: 'edit',
    disclosure: 'inspector',
    hint: 'Rename the selected canonical object or part',
    run: (ctx, invocation) => {
      const request = invocation.objectsRename;
      if (!request) {
        ctx.reportCapabilityUnavailable('Rename object or part', 'Choose Rename on an object or part row.');
        return;
      }
      ctx.renameObjectsTreeEntity(request.entity, request.name);
    },
  },
  {
    id: 'objects_reveal',
    label: 'Reveal object in scene',
    icon: 'view',
    group: 'view',
    disclosure: 'inspector',
    hint: 'Activate and frame the canonical scene entity represented by an Objects row',
    run: (ctx, invocation) => {
      if (!invocation.objectsReveal) {
        ctx.reportCapabilityUnavailable('Reveal object in scene', 'Choose Reveal on an Objects row.');
        return;
      }
      ctx.revealObjectsTreeEntity(invocation.objectsReveal);
    },
  },
  {
    id: 'objects_assign_filament',
    label: 'Assign filament to Objects selection',
    icon: 'filament',
    group: 'filament',
    disclosure: 'inspector',
    hint: 'Assign a stable physical or mixed filament to selected objects, parts, or height ranges',
    run: (ctx, invocation) => {
      const request = invocation.objectsFilamentAssignment;
      if (!request) {
        ctx.reportCapabilityUnavailable(
          'Assign filament to Objects selection',
          'Choose a filament for an assignable Objects selection.',
        );
        return;
      }
      ctx.assignObjectsTreeFilament(request.entities, request.filamentId, request);
    },
  },
  {
    id: 'objects_convert_volume_role',
    label: 'Convert semantic volume role',
    icon: 'modifier',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Convert one existing canonical part between supported semantic volume roles',
    run: (ctx, invocation) => {
      if (!invocation.semanticVolumeRole) {
        ctx.reportCapabilityUnavailable('Convert semantic volume role', 'Select a part and choose a compatible role.');
        return;
      }
      ctx.convertSemanticVolumeRole(invocation.semanticVolumeRole);
    },
  },
  {
    id: 'objects_edit_layer_range',
    label: 'Edit object height ranges',
    icon: 'height_range',
    group: 'scene',
    disclosure: 'inspector',
    hint: 'Add, edit, split, merge, or delete one canonical object height range',
    run: (ctx, invocation) => {
      if (!invocation.semanticLayerRange) {
        ctx.reportCapabilityUnavailable(
          'Edit object height ranges',
          'Select an object and choose a height-range edit.',
        );
        return;
      }
      ctx.editSemanticLayerRange(invocation.semanticLayerRange);
    },
  },
];
