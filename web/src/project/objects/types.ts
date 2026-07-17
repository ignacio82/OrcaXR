import type { FilamentId, ObjectId, PlateId } from '../domain/ids';
import type { ProjectState, VolumeRole } from '../domain/model';
import type { SelectionRef, SelectionSnapshot } from '../selection';

export type ObjectTreeEntityRef = Exclude<SelectionRef, { kind: 'project' } | { kind: 'filament' }>;

export type ObjectTreeRowKind =
  | 'plate'
  | 'object'
  | 'volume'
  | 'instance-group'
  | 'instance'
  | 'settings'
  | 'layer-group'
  | 'layer-range'
  | 'info'
  | 'error';

export type ObjectTreeRowKey = string;

export interface ObjectTreeFilamentBadge {
  readonly id: FilamentId;
  readonly name: string;
  readonly color: string;
  readonly mixed: boolean;
  readonly inherited: boolean;
}

export interface ObjectTreePaintIndicators {
  readonly colorFacetCount: number;
  readonly supportFacetCount: number;
}

export interface ObjectTreeIndicators {
  readonly printable?: boolean;
  readonly filament?: ObjectTreeFilamentBadge;
  readonly paint?: ObjectTreePaintIndicators;
  /** Geometry-derived status is supplied by the render/preflight projection. */
  readonly sinking?: boolean;
  readonly editable: boolean;
  readonly settingsCount?: number;
  readonly volumeRole?: VolumeRole;
}

export interface ObjectTreeRow {
  readonly key: ObjectTreeRowKey;
  readonly id: string;
  readonly kind: ObjectTreeRowKind;
  readonly parentKey?: ObjectTreeRowKey;
  readonly childrenKeys: readonly ObjectTreeRowKey[];
  readonly label: string;
  readonly description?: string;
  /** Present only when selecting this row selects a distinct canonical entity. */
  readonly entity?: ObjectTreeEntityRef;
  /** Synthetic settings/diagnostic rows retain their canonical context here. */
  readonly owner?: ObjectTreeEntityRef;
  readonly indicators: ObjectTreeIndicators;
  readonly searchText: string;
}

export interface ObjectTreeProjection {
  readonly rowsByKey: ReadonlyMap<ObjectTreeRowKey, ObjectTreeRow>;
  readonly rootKeys: readonly ObjectTreeRowKey[];
  readonly entityRowKeys: ReadonlyMap<string, ObjectTreeRowKey>;
  readonly defaultExpandedKeys: readonly ObjectTreeRowKey[];
}

export interface ObjectTreeDiagnostic {
  /** Stable within the owning validation/preflight subsystem. */
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly entity?: ObjectTreeEntityRef;
  readonly parentKey?: ObjectTreeRowKey;
}

export interface ObjectTreeExternalStatus {
  readonly printable?: boolean;
  readonly sinking?: boolean;
  readonly editable?: boolean;
}

export interface ObjectTreeProjectionOptions {
  readonly diagnostics?: readonly ObjectTreeDiagnostic[];
  readonly resolveStatus?: (state: ProjectState, entity: ObjectTreeEntityRef) => ObjectTreeExternalStatus | undefined;
}

export interface ObjectTreeAccessibility {
  readonly level: number;
  readonly positionInSet: number;
  readonly setSize: number;
  readonly expanded?: boolean;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly tabIndex: 0 | -1;
}

export interface ObjectTreeVisibleRow extends ObjectTreeRow {
  readonly accessibility: ObjectTreeAccessibility;
  readonly matchedFilter: boolean;
  readonly focused: boolean;
}

export interface ObjectTreeView {
  readonly rows: readonly ObjectTreeVisibleRow[];
  readonly rowsByKey: ReadonlyMap<ObjectTreeRowKey, ObjectTreeVisibleRow>;
  readonly indexByKey: ReadonlyMap<ObjectTreeRowKey, number>;
  readonly focusKey?: ObjectTreeRowKey;
  readonly filterQuery: string;
  readonly filterActive: boolean;
}

export interface ObjectTreeViewOptions {
  readonly expandedKeys?: ReadonlySet<ObjectTreeRowKey>;
  readonly filterQuery?: string;
  readonly selection?: SelectionSnapshot;
  readonly focusedKey?: ObjectTreeRowKey;
}

export interface ObjectTreeObjectContext {
  readonly plateId: PlateId;
  readonly objectId: ObjectId;
}
