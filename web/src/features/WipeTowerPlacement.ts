/**
 * Wipe-tower auto-positioning — web port of Android `WipeTowerPlacement.kt`
 * (Roadmap A13). Scores an 8-candidate grid (4 corners + 4 mid-edges) and
 * picks the position with the largest minimum L∞ clearance to every part.
 *
 * Coordinates match libslic3r: bed origin (0,0), +X right, +Y back;
 * wipe_tower_x/y is the LEFT-FRONT corner of the tower's AABB.
 */

export * from '../project/objects/wipeTowerPlacement';
