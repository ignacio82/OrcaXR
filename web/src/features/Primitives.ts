export enum PrimitiveKind {
    CUBE = 'CUBE',
    CYLINDER = 'CYLINDER',
    SPHERE = 'SPHERE',
    CONE = 'CONE',
    TORUS = 'TORUS',
    DISC = 'DISC',
    SLAB = 'SLAB'
}

export enum ModelVolumeType {
    MODEL_PART = 0,
    NEGATIVE_VOLUME = 1,
    PARAMETER_MODIFIER = 2,
    SUPPORT_ENFORCER = 3,
    SUPPORT_BLOCKER = 4
}
